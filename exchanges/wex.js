const Base = require('../base')
const BtceService = require('btc-e-v3')
const Pusher = require('pusher-js')

class Wex extends Base {
  constructor(option) {
    super(option)

    // Инициализация соединения
    this.btce = new BtceService({
      publicKey: this.api.key,
      secretKey: this.api.secret
    })

    this.socket = new Pusher('ee987526a24ba107824c', { cluster: 'eu' })
    this.channel = this.socket.subscribe(`${this.pair}.trades`)
  }

  init() {
    this.console(`run wex ${this.pair}`.green)

    // Формирование структурированных данных транзакций
    setTimeout(async () => {
      // Первая запуск загружает большой список данных
      await this.firstLoadTrades()

      // Теперь получаем данные в реальном времени
      this.trades()
    }, 1000)

    // Заносим активные ордеры в массив
    setInterval(() => this.observeActiveOrders(), 1000)

    // Наблюдение за ордерами
    setInterval(() => this.observeOrders(), 1000)

    // Отслеживать каждую минуту ситуацию на рынке
    setInterval(() => this.observe(), 60000)
  }

  // Последняя транзакция
  async lastTransaction() {
    try {
      // Последняя транзакция
      const trandeHistory = await this.btce.tradeHistory({ from: 0, count: 1, pair: this.pair })
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

  // Получить данные кошельков
  async getWallets () {
    try {
      const info = await this.btce.getInfo()
      return info.funds

    } catch (e) {
      this.console('Error getWallets', e.error)
    }
  }

  // Данные кошелька
  async getBalance () {
    const wallets = await this.getWallets()
    const data = []
    for (let item in wallets) {
      data.push({ type: item, value: wallets[item] })
    }
    return data
  }

  // История сделок
  async getHistory () {
    try {
      const history = await this.btce.tradeHistory({ count: 20, order: 'DESC' })
      const data = []

      for (let item in history) {
        data.push(history[item])
      }
      return data
    } catch (e) {
      console.log('Error getHistory', e.error)
    }
  }

  // Получаем объем для продажи
  async getSellAmount () {
    const wallets = await this.getWallets()
    const [wallet] = this.pair.split('_')
    return wallets[wallet]
  }

  // Получаем объем исходя из курса и суммы денег
  async buyAmount(rate) {
    try {
      const wallets = await this.getWallets()
      const [, wallet] = this.pair.split('_')
      const distribution = []
      
      // Находим пустые кошельки
      for (let key in wallets) {
        if (this.percentWallet.includes(key) && wallets[key] === 0) {
          distribution.push({
            wallet: key,
            value: wallets[key]
          })
        }
      }

      // Если всего 1 кошелек пустой, отдаем всю сумму
      if (distribution.length === 1) {
        // Доступно для использования
        return parseFloat((wallets[wallet] / rate).toFixed(8))
      } else {
        // Разделяем на части
        return parseFloat(((wallets[wallet] / distribution.length) / rate).toFixed(8))
      }
    } catch (e) {
      console.log('Error buyAmount', e)
    }
  }

  // Выставление на продажу
  async sale(rate, amount) {
    try {
      // Цена продажи
      let price = this.getMarkupPrice(rate)

      // Выставляем на продажу
      let buy = await this.btce.trade({
        pair: this.pair,
        type: 'sell',
        rate: price,
        amount: parseFloat((amount - this.getCommission(amount)).toFixed(8))
      })
    } catch (e) {
      this.console('Ошибка продажи', e.error)
    }
  }

  // Отмена ордера по истичению 15 минут
  async orderCancelLimit(id, order) {
    // Если ордер выполнен, пропускам проверку
    if (order.status === 1) return false

    const currentTime = Math.floor(Date.now() / 1000)

    // Если срок жизни прошел, отменяем ордер
    if (currentTime > (order.timestamp_created + this.config.timeOrder)) {
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
  async observeOrders() {
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
          const amount = await this.getSellAmount()

          // Оповещаем пользователя о купле
          this.sendMessage(`💰 Частично купили ${amount} ${this.pair} из ${order.start_amount} по курсу ${order.rate}\n order_id: ${id}`)

          // Формируем минимальную цену продажи
          const markupPrice = this.getMarkupPrice(order.rate)

          // Выставляем частично купленный объем на продажу
          this.task = {
            type: 'sell',
            buyAmount: order.rate,
            startAmount: amount,
            price: markupPrice,
            minPrice: markupPrice, // минимальная достигнутая цена
            maxPrice: markupPrice, // максимальная, на данный момент это цена закупки
            currentPrice: markupPrice,
            amount: amount,
            timestamp: Date.now()
          }

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
          this.sendMessage(`💰 Купили ${order.start_amount} ${this.pair} по курсу ${order.rate}\n order_id: ${id}`)

          // Формируем минимальную цену продажи
          const markupPrice = this.getMarkupPrice(order.rate)

          // Объем, который мы купили
          const amount = await this.getSellAmount()

          // Выставляем на продажу
          this.task = {
            type: 'sell',
            buyAmount: order.rate,
            startAmount: order.start_amount,
            price: markupPrice,
            minPrice: markupPrice, // минимальная достигнутая цена
            maxPrice: markupPrice, // максимальная, на данный момент это цена закупки
            currentPrice: markupPrice,
            amount: amount,
            timestamp: Date.now()
          }
        } else {
          // Считаем заработок
          const income = (this.task.amount * order.rate) - (this.task.startAmount * this.task.buyAmount)

          // Прибавляем заработок
          this.income += income

          // Очищаем задачу
          this.task = null
          
          // Оповещаем о продаже
          this.sendMessage(`🎉 Продали ${order.start_amount} ${this.pair} по курсу ${order.rate} \norder: ${id}`)
        }

        // Удаляем ордер из наблюдения
        this.removeOrder(id)

      } catch (e) {
        this.console('Error observeOrders:', e)
      }
    })
  }

  // Наблюдение за активными ордерами
  async observeActiveOrders() {
    try {
      // Получение списка активных ордеров
      const activeOrders = await this.btce.activeOrders(this.pair)
      for (let id in activeOrders) {
        if (!this.orders.filter(item => item === id).length) {
          this.orders.push(id)
        }
      }
    } catch (e) {
      if (e.error !== 'no orders') {
        this.console('Error observeActiveOrders', e.error)
      }
    }
  }

  // Формирование структурированных данных в реальном времени
  trades() {
    this.channel.bind('trades', async item => await this.addElementCandles(item[0]))
  }

  // Формирование структурированных данных купли/продажи
  async firstLoadTrades() {
    try {
      const trades = await this.btce.trades(this.pair, 5000)
      for (let item of trades[this.pair].reverse()) {
        await this.addElementCandles([item.type, item.price, item.amount], item.timestamp * 1000, false)
      }
    } catch (e) {
      this.console('Error trades:', e.error)
    }
  }

  // Наблюдение за последними свечами, для выявления покупки
  async observe() {
    // Не выполняем наблюдение, если есть задача
    if (this.task !== null) {
      return null
    }

    try {
      if (!this.candles.length || this.candles.length < 120) {
        this.console(`observe: недостаточное количество свеч ${this.pair}`.bgRed.white, this.candles.length)
        return false
      }

      try {
        // Получение списка активных ордеров
        await this.btce.activeOrders(this.pair)

        // Есть активный ордер, ожидаем завершения
        this.console(`observe: есть активный ордер ${this.pair}`)
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
        // Восстанавливаем процесс продажи после остановки бота

        // Минимальная сумма продажи
        const minSellPrice = this.getMarkupPrice(lastTrade.rate)

        // Объем для продажи
        const amount = await this.getSellAmount()

        // Выставляем на продажу не отловленную покупку
        this.task = {
          type: 'sell',
          buyAmount: lastTrade.rate,
          startAmount: lastTrade.start_amount,
          price: minSellPrice,
          minPrice: minSellPrice, // минимальная достигнутая цена
          maxPrice: minSellPrice, // максимальная, на данный момент это цена закупки
          amount: amount,// Цена продажи с вычетом коммиссии
          currentPrice: minSellPrice,
          timestamp: Date.now()
        }
        return false
      }

      // Поиск выгодного момента
      for (let item of data) {
        if (current.price.min > item.price.min) {
          // Не самая выгодная цена, сделка сорвана
          this.console(`observe: не подходящий момент для инвестиции`, { current: current.price.min, min: item.price.min })
          return false
        }
      }

      // Курс по которому мы купим
      const minPrice = parseFloat(((current.price.min * (0.02 / 100)) + current.price.min).toFixed(3))

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
          this.console(`👁 Запущено наблюдение, объем: ${amount} ${this.pair}, цена: ${minPrice}`.yellow.underline)

          // Добавляем задачу
          this.task = {
            type: 'buy',
            price: minPrice,
            minPrice: minPrice, // минимальная достигнутая цена
            currentPrice: minPrice,
            amount: amount,
            repeat: 30,
            bottom: 0, // если дно будет равно 1, то подтверждаем что это дно и покупаем
            timestamp: Date.now()
          }
        } catch (e) {
          this.console(`Buy error:`, e.error)
        }
      }
    } catch (e) {
      this.console(`Error observe: ${e.error}`, e)
    }
  }

  // Ожидание дна
  async watch(transaction) {
    if (!transaction || !this.task) return false

    // Устанавливаем текущий курс
    this.task.currentPrice = transaction

    // Покупка
    const buy = async () => {
      // Если цена на протяжении долгого времени стоит высокой, удаляем задачу
      if (!this.task.repeat) {
        this.console(`Тайм-аут задачи ${this.pair}`.bgRed.white)
        this.task = null
        return false
      }

      const params = {
        'наблюдение': this.task.price,
        'текущий': transaction,
        'минимум': this.task.minPrice
      }

      // Курс падает, ждем дна
      if (transaction <= this.task.minPrice) {
        this.console(`buy: курс падает ${this.pair}`, params)
        this.task.minPrice = transaction
      } else {

        // Если цена последней транзакции выросла
        // по сравнению с минимальной ценой, а так же все еще ниже часового минимума
        if (((1 - (this.task.minPrice / transaction)) * 1000) >= 2) {
          if (((1 - (this.task.minPrice / transaction)) * 1000) >= 4) {
            this.task.repeat--
            this.console(`buy: высокий ${this.pair}`.red, params)
            return false
          }
          this.console(`buy: дно ${this.pair}`.gray, params)

          // Цена ниже установленного минимума
          if (transaction <= this.task.price) {
            this.console(`buy: рентабельно ${this.pair}`.yellow, params)

            // Повторно проверяем
            if (this.task.bottom !== 1) {
              this.task.bottom++
              this.console('buy: проверка суммы...'.underline)
              return false
            }

            try {
              this.console(`buy: инвестируем ${this.pair} ${this.task.amount} по курсу $${transaction}`.bgGreen.white, params)

               // Объем покупки
               const amount = parseFloat(this.task.amount).toFixed(8)

              // Отправляем заявку на покупку
              await this.btce.trade({
                pair: this.pair,
                type: 'buy',
                rate: transaction,
                amount: amount // с учетом коммисии
              })

              // Обнуляем задачу
              this.task = null

            } catch (e) {
              this.console('Error watch buy:', e, this.task)
            }
          } else {
            // Цена выросла по сравнению с установленным минимумом...

            // Я думаю если она выросла не значительно, то можно брать...
            // Надо подумать, стоит ли брать
            this.console(`Цена выросла по сравнению с минимумом ${this.pair}`, params)
          }
        } else {
          // Цена немного выросла, но не значительно, ждем дна
          this.console(`Цена растет, но незначительно ${this.pair}`, params)
        }
      }
    }

    // Продажа
    const sell = async () => {
      const params = {
        'старт': this.task.price,
        'сейчас': transaction,
        'максимум': !this.task.maxPrice ? this.task.maxPrice : this.task.price
      }

      // Текущая цена ниже установленного минимума
      if (transaction < this.task.price) {
        this.console(`sell: курс ${transaction} ${this.pair} ниже установленного минимума ${this.task.price}`)
        return false
      }

      // Курс растет, ждем пика
      if (transaction > this.task.maxPrice) {
        this.task.maxPrice = transaction
        this.console('sell: курс растет')
      } else {

        // Если цена последней транзакции снизилась
        // по сравнению с максимальной ценой, а так же все еще выше часового минимума
        if (((1 - (transaction / this.task.maxPrice)) * 1000) >= 3) {
          this.console(`sell: максимум, курс снижается ${this.pair}`, params)

          // Цена выше установленного минимума
          if (transaction >= this.task.price) {
            this.console(`sell: цена выше установленного минимума ${this.pair}`, params)
            try {
              this.console(`sell: продаем ${this.pair} ${this.task.amount} по курсу: ${transaction}`, params) 

              // Объем продажи
              const amount = parseFloat(this.task.amount).toFixed(8)

              // Отправляем заявку на продажу
              await this.btce.trade({
                pair: this.pair,
                type: 'sell',
                rate: transaction,
                amount: amount // с учетом коммисии
              })

              // Обнуляем задачу
              this.task = null

            } catch (e) {
              this.console('Error sell', e)
            }
          } else {
            // Цена упала по сравнению с установленным минимумом...

            // Я думаю если она упала не значительно, то можно продовать...
            // Надо подумать, стоит ли продовать
            this.console(`sell: цена упала по сравнению с устаовленным минимумом ${this.pair} [начало: ${this.task.price}, сейчас: ${transaction}, максимум: ${this.task.maxPrice}]`)
          }
        } else {
          // Цена немного упала, но не значительно, ждем пика
          this.console(`sell: цена ${transaction} ${this.pair} упала по сравнению с пиком ${this.task.maxPrice}`, params)
        }
      }
    }

    // Выполняем тип в зависимости от задачи
    this.task.type === 'buy' ? buy() : sell()
  }
}

module.exports = Wex
