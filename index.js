const config = require('./conf')
const BtceService = require('btc-e-v3')
const sendMessage = require( './libs/telegram')
const colors = require('colors')
const moment = require('moment') 

class BTCTraderBot {
  constructor() {
    // Инициализация соединения
    this.btce = new BtceService({ publicKey: config.key, secretKey: config.secret })

    // Вся история движения
    this.history = []

    // Активные ордеры
    this.orders = []

    // Свечи
    this.candles = []

    // Задача
    this.task = null
  }

  init () {
    this.console('Старт бота'.green)

    // Формирование структурированных данных транзакций
    setTimeout(async () => {
      // Первая запуск загружает большой список данных
      await this.trades()

      // Теперь просто загружаем список постепенно
      setInterval(this.trades, 1000)
    }, 1000)

    // Наблюдение за ордерами
    setInterval(() => this.observeActiveOrders(), 1000)

    // Наблюдение за ордерами
    setInterval(() => this.observeOrders(), 5000)

    // Отслеживать каждую минуту ситуацию на рынке
    setInterval(() => this.observe(), 60000)
  }

  // Поиск в истории транзакций
  findHistory (tid) {
    return this.history.filter(item => item.tid === tid).length
  }

  // Последняя транзакция
  async lastTransaction () {
    try {
      // Последняя транзакция
      const trandeHistory = await this.btce.tradeHistory({ from: 0, count: 1 })
      let last = null
      for (let item in trandeHistory) {
        if (!last) {
          last = trandeHistory[item]
          last.id = item
        }
      }
      return last
    } catch (e) {
      return { type: 'sell' }
    }
  }

  // Удаление ордера
  removeOrder (id) {
    return this.orders.filter(item => item !== id)
    // for (let key in this.orders) {
    // 	if (orders[key] === id) {
    // 		orders.splice(key, 1)
    // 	}
    // }
  }

  // Формирование цены продажи
  getMarkupPrice (rate) {
    return parseFloat(((rate * ((config.markup + config.commission) / 100)) + rate).toFixed(3))
  }

  // Получаем коммисию
  getCommission (amount) {
    return parseFloat((amount - (amount * (1 - (config.commission / 100)))).toFixed(8))
  }

  // Получаем объем исходя из курса и суммы денег
  async buyAmount (rate) {
    const info = await this.btce.getInfo()
    return parseFloat((info.funds.usd / rate).toFixed(8))
  }

  // Выставление на продажу
  async sale (rate, amount) {
    try {
      // Цена продажи
      let price = this.getMarkupPrice(rate)

      // Выставляем на продажу
      let buy = await this.btce.trade({
        pair: config.pair,
        type: 'sell',
        rate: price,
        amount: parseFloat((amount - this.getCommission(amount)).toFixed(8))
      })

      // Оповещаем пользователя о выставлении на продажу
      sendMessage(`💰 Выставили на продажу ${amount} btc по курсу ${price}\n order: ${buy.order_id}`)

    } catch (e) {
      this.console('Ошибка продажи', e.error)
      sendMessage(`Ошибка продажи: ${e.error}`)
    }
  }

  // Вывод в консоль с текущим временем
  console (text, params = '') {
    console.log(`${text} [${moment().format('LLL')}]`, params)
  }

  // Отмена ордера по истичению 15 минут
  async orderCancelLimit (id, order) {
    // Если ордер выполнен, пропускам проверку
    if (order.status === 1) return false

    let currentTime = Math.floor(Date.now() / 1000)

    // Если срок жизни прошел, отменяем ордер
    if (currentTime > (order.timestamp_created + config.timeOrder)) {
      try {
        // Отмена ордера
        await this.btce.cancelOrder(id)

        // Сообщаем об удалении
        this.console(`${id} истек срок`)

        return true
      } catch (e) {
        this.console(`Error orderCancelLimit: ${order.id}`)

        // ошибка удаления
        return false
      }
    }
    // Срок ордера еще не окончен
    return false
  }

  // Наблюдение за ордерами
  async observeOrders () {
    this.orders.map(async id => {
      try {
        const info = await this.btce.orderInfo(id)
        const order = info[id]

        // Если ордер отменен, удаляем его из наблюдения
        if (order.status === 2) {
          this.removeOrder(id)
          return false
        }

        // Если ордер на половину выполнен, но срок прошел
        // выставляем на продажу купленный объем
        if (order.status === 3) {
          this.console('Ордер на половину выполнен:', order)

          // Объем, который мы купили
          const buyAmount = (order.start_amount - order.amount)

          // Оповещаем пользователя о купле
          sendMessage(`💰 Частично купили ${buyAmount} btc из ${order.start_amount} btc по курсу ${order.rate}\n order_id: ${id}`)

          // очищаем задачу
          this.task = null

          // Выставляем частично купленный объем на продажу
          await this.sale(order.rate, buyAmount)

          // Удаляем частично выполненный ордер
          this.removeOrder(id)

          return false
        }

        // Проверяем срок ордера на покупку
        if (order.type === 'buy' && await this.orderCancelLimit(id, order)) return false

        // Оповещаем только о завершенных ордерах
        if (order.status !== 1) return false

        if (order.type === 'buy') {

          // Оповещаем пользователя о купле
          sendMessage(`💰 Купили ${order.start_amount} BTC по курсу ${order.rate}\n order_id: ${id}`)

          // очищаем задачу
          this.task = null

          // Выставляем на продажу
          await this.sale(parseFloat(order.rate.toFixed(3)), parseFloat(order.start_amount.toFixed(8)))
        } else {
          // Оповещаем о продаже
          sendMessage(`🎉 Продали ${config.amount} BTC по курсу ${order.rate}\nнаценка: ${order.markup}%\norder: ${id}`)
        }

        // Удаляем ордер из наблюдения
        this.removeOrder(id)

      } catch (e) {
        this.console('Error observeOrders:', e.error)
      }
    })
  }

  // Наблюдение за активными ордерами
  async observeActiveOrders () {
    try {
      // Получение списка активных ордеров
      this.console('await this.btce.activeOrders(config.pair)', await this.btce.activeOrders(config.pair))
      const activeOrders = await this.btce.activeOrders(config.pair)
      for (let id in activeOrders) {
        if (!this.orders.filter(item => item === id).length) {
          this.orders.push(id)
        }
      }
    } catch (e) {
      if (e.error !== 'no orders') {
        this.console('Error observeActiveOrders')
      }
    }
  }

  // Формирование структурированных данных купли/продажи
  async trades () {
    try {
      const trades = await this.btce.trades(config.pair, (!this.history.length ? 5000 : 150))
      for (let item of trades[config.pair].reverse()) {

        // Пропускаем повторы
        if (this.findHistory(item.tid)) continue

        // Добавляем элемент в историю
        this.history.unshift(item)

        const date = new Date(item.timestamp * 1000)
        if (this.candles.length === 0 || this.candles[0].date.getMinutes() !== date.getMinutes()) {
          // Добавление новой минутной свечи
          this.candles.unshift({
            date: date,
            timestamp: item.timestamp,
            type: null,
            difference: 0,
            price: {},
            amount: 0,
            items: []
          })
        }

        // Отправляем данные в ожидание для покупки/продажи
        if (this.history.length > 5000) {
          await this.watch(item)
        }

        // Вставляем событие в текущую свечи
        this.candles[0].items.unshift(item)

        // Расчет мин и макс
        this.candles[0].price.min = !this.candles[0].price.min
          ? item.price
          : (item.price < this.candles[0].price.min ? item.price : this.candles[0].price.min)

        this.candles[0].price.max = !this.candles[0].price.max
          ? item.price
          : (item.price > this.candles[0].price.max ? item.price : this.candles[0].price.max)

        // Объем
        this.candles[0].amount += item.amount
      }
    } catch (e) {
      if (e.toString() !== "TypeError: Cannot read property 'trades' of undefined") {
        this.console(`Error trades: ${e.error}`)
      }
    }
  }

  // Наблюдение за последними свечами, для выявления покупки
  async observe () {
    try {
      if (!this.candles.length || this.candles.length < 120) {
        return false
      }

      try {
        // Получение списка активных ордеров
        await this.btce.activeOrders(config.pair)

        // Есть активный ордер, ожидаем завершения
        return false
      } catch (e) {
        // Не обрабатываем исключение
        // так как, нам нужно отсутствие ордеров
      }

      // Получаем последние свечи
      const data = this.candles.filter((item, index) => index <= 60)

      // Текущая обстановка на рынке
      const current = data.shift()

      // Последняя транзакция
      const lastTrade = await this.lastTransaction()

      // Ожидаем, что последняя транзакция, это продажа
      if (lastTrade.type === 'buy' || this.task !== null) {
        return false
      }

      // Поиск выгодного момента
      for (let item of data) {
        if (current.price.min > item.price.min) {
          // Не самая выгодная цена, сделка сорвана
          return false
        }
      }

      // Курс по которому мы купим btc
      const minPrice = parseFloat(((current.price.min * (0.05 / 100)) + current.price.min).toFixed(3))

      // объем исходя из всей суммы
      const amount = await this.buyAmount(minPrice)

      // Минимальная цена продажи
      const markupPrice = this.getMarkupPrice(minPrice)

      let markupPriceMin = null
      let markupPriceMax = null
      let resolution = false

      // Получаем необходимое количество свечей
      let markupData = this.candles.filter((item, index) => index <= 720)
      for (let item of markupData) {

        // Если цена валюты достигала за последние n минут markupPrice
        // то разрешаем покупать валюту
        if (markupPrice <= item.price.max) {
          resolution = true
        }

        markupPriceMin = markupPriceMin === null
          ? item.price.min
          : (markupPriceMin < item.price.min ? markupPriceMin : item.price.min)

        markupPriceMax = markupPriceMax === null
          ? item.price.max
          : (markupPriceMax > item.price.max ? markupPriceMax : item.price.max)
      }

      if (resolution) {
        // Покупаем
        try {
          this.console(`👁 Запущено наблюдение, объем: ${amount}, цена: ${minPrice}`.yellow.underline)

          // Добавляем задачу
          this.task = {
            type: 'buy',
            price: minPrice,
            minPrice: minPrice, // минимальная достигнутая цена
            amount: amount,
            repeat: 30,
            bottom: 0 // если дно будет равно 1, то подтверждаем что это дно и покупаем
          }
        } catch (e) {
          this.console(`Buy error:`, e.error)
        }
      }
    } catch (e) {
      this.console(`Error observe: ${e.error}`)
    }
  }

  // Ожидание дна
  async watch (transaction) {
    if (!transaction || !this.task) return false

    // Если цена на протяжении долгого времени стоит высокой, удаляем задачу
    if (!this.task.repeat) {
      this.console('Тайм-аут задачи'.bgRed.white)
      this.task = null
      return false
    }

    // Покупка
    const buy = async () => {
      const params = {
        'наблюдение': this.task.price,
        'текущий': transaction.price,
        'минимум': this.task.minPrice
      }

      // Курс падает, ждем дна
      if (transaction.price < this.task.minPrice) {
        this.task.minPrice = transaction.price
      } else {

        // Если цена последней транзакции выросла
        // по сравнению с минимальной ценой, а так же все еще ниже часового минимума
        if (((1 - (this.task.minPrice / transaction.price)) * 1000) >= 3) {
          if (((1 - (this.task.minPrice / transaction.price)) * 1000) >= 4) {
            this.task.repeat--
            this.console(`Высокий`.red, params)
            return false
          }
          this.console(`Дно`.gray, params)

          // Цена ниже установленного минимума
          if (transaction.price <= this.task.price) {
            this.console(`Рентабельно`.yellow, params)

            // Повторно проверяем
            if (this.task.bottom !== 1) {
              this.task.bottom++
              this.console('Проверка суммы...'.underline)
              return false
            }

            try {
              this.console(`Инвестируем ${this.task.amount} по курсу $${transaction.price}`.bgGreen.white, params)

              // Минимальная цена продажи
              const markupPrice = this.getMarkupPrice(transaction.price)
              const amount = this.getCommission(this.task.amount)

              // Покупаем валюту
              this.task = {
                type: 'sell',
                price: markupPrice,
                minPrice: markupPrice, // минимальная достигнутая цена
                maxPrice: markupPrice, // максимальная, на данный момент это цена закупки
                amount: this.task.amount,
                repeat: 30
              }

              // sendMessage(`⌛ Запрос на покупку ${this.task.amount} btc по курсу ${transaction.price}`)

              // let buy = await btce.trade({
              //   pair: config.pair,
              //   type: 'buy',
              //   rate: transaction.price,
              //   amount: task.amount // с учетом коммисии
              // })

              // Оповещаем об покупке
              // const consumption = (this.task.amount * transaction.price).toFixed(3)
              // const commission = this.getCommission(task.amount)

              // sendMessage(`
							// 	⌛ Запрос на покупку ${this.task.amount} btc по курсу ${transaction.price}
							// 	расход: $${consumption}
							// 	получим: ${(this.task.amount - commission)} btc
							// 	коммисия: $${(commission * transaction.price)} (${commission} btc)
							// 	наценка: ${config.markup}%
							// 	мин. цена: $${this.task.minPrice}
							// 	макс. цена: $${this.task.price}
							// 	order: ` // ${buy.order_id}
              // )

            } catch (e) {
              this.console('Error watch buy:', e.error, this.task)
            }
          } else {
            // Цена выросла по сравнению с установленным минимумом...

            // Я думаю если она выросла не значительно, то можно брать...
            // Надо подумать, стоит ли брать
            this.console(`Цена выросла по сравнению с минимумом`, params)
          }
        } else {
          // Цена немного выросла, но не значительно, ждем дна
          this.console(`Цена растет, но незначительно`, params)
        }
      }
    }

    // Продажа
    const sell = async () => {
      const params = {
        'старт': this.task.price,
        'сейчас': transaction.price,
        'максимум': !this.task.maxPrice ? this.task.maxPrice : this.task.price
      }

      // Курс растет, ждем пика
      if (transaction.price > this.task.maxPrice) {
        this.task.maxPrice = transaction.price
      } else {

        // Если цена последней транзакции снизилась
        // по сравнению с максимальной ценой, а так же все еще выше часового минимума
        if (((1 - (transaction.price / this.task.maxPrice)) * 1000) >= 3) {
          if (((1 - (transaction.price / this.task.maxPrice)) * 1000) >= 4) {
            this.task.repeat--
            this.console(`Упал`, params)
            return false
          }

          this.console(`Максимум, курс снижается`, params)

          // Цена выше установленного минимума
          if (transaction.price >= this.task.price) {
            this.console(`Цена выше установленного минимума`, params)
            try {
              this.console(`Продаем ${this.task.amount} по курсу: ${transaction.price}`, params)
              this.task = null
              // Продаем валюту
              sendMessage(`⌛ Выставляем на продужу на покупку ${this.task.amount} btc по курсу ${transaction.price}`)

            } catch (e) {
              this.console('Error sell', e.error)
            }
          } else {
            // Цена упала по сравнению с установленным минимумом...

            // Я думаю если она упала не значительно, то можно продовать...
            // Надо подумать, стоит ли продовать
            this.console(`Цена упала по сравнению с устаовленным минимумом [начало: ${this.task.price}, сейчас: ${transaction.price}, максимум: ${this.task.maxPrice}]`)
          }
        } else {
          // Цена немного упала, но не значительно, ждем пика
          this.console(`Цена ${transaction.price} упала по сравнению с пиком ${this.task.maxPrice}`, params)
        }
      }
    }

    // Выполняем тип в зависимости от задачи
    this.task.type === 'buy' ? buy() : sell()
  }
}

// init
const Bot = new BTCTraderBot()
Bot.init()