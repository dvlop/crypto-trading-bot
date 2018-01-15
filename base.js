const config = require('./conf')
const moment = require('moment')

class Base {
  constructor({ api, pair, percentWallet, telegram, purseBuy, purseSell, decimial, commission = 0.2, markup = 1 } = {}) {
    // Доступы к API
    this.api = config.api[api]

    // Кошелек покупки
    this.purseBuy = purseBuy

    // Кошелек продажи
    this.purseSell = purseSell

    // Конфигурационные данные
    this.config = config

    // Пара
    this.pair = pair

    // Коммисия за 1 операцию
    this.commission = commission

    // Наша накидка
    this.markup = markup

    // Какой процент кошелька использовать
    this.percentWallet = percentWallet

    // Активные ордеры
    this.orders = []

    // Свечи
    this.candles = []

    // Задача
    this.task = null

    // История транзакций
    this.history = []

    // Общий заработок
    this.income = 0

    // Дата запуска бота
    this.startTimestamp = Date.now()

    // Методы для отправки и обработки сообщений от разработчика
    this.telegram = telegram

    // Обработка команд
    this.telegram.init(this)

    // Обозначение текущего аккаунта
    this.login = this.api.login

    // Объект для доступа к API биржи
    this.query = null

    // Количество нулей после запятой
    this.decimial = decimial
  }

  // Инициализация
  init() {
    // Заносим активные ордеры в массив
    setInterval(() => this.observeActiveOrders(), 1000)

    // Наблюдение за ордерами
    setInterval(() => this.observeOrders(), 1000)

    // Отслеживать каждую минуту ситуацию на рынке
    setInterval(() => this.observe(), 60000)

    // Метод заполнения свечей, у каждой биржи своя реализация
    this.trades()
  }

  // Обработка транзакций
  async trades() {
    // Метод необходимо реализовать в каждом дочернем объекте
  }

  // Поиск в истории транзакций
  findHistory(id) {
    return this.history.includes(id)
  }

  // Удаление ордера
  removeOrder(id) {
    return this.orders.splice(this.orders.indexOf(id), 1)
  }

  // Формирование цены продажи
  getMarkupPrice(rate) {
    return parseFloat(((rate * ((this.markup + (this.commission * 2)) / 100)) + rate).toFixed(8))
  }

  // Получаем коммисию
  getCommission(amount) {
    return parseFloat((amount - (amount * (1 - (this.commission / 100)))).toFixed(8))
  }

  // Обертка над sendMessage
  sendMessage(message) {
    this.telegram.sendMessage(message)
  }

  // Добавить новую свечу или вставить в текущую
  async addElementCandles(item, timestamp = Date.now(), watch = true) {
    // Преобразовываем в число
    item[1] = parseFloat(item[1])
    item[2] = parseFloat(item[2])

    const [type, price, amount] = item
    const date = new Date(timestamp)

    if (this.candles.length === 0 || this.candles[0].date.getMinutes() !== date.getMinutes()) {
      // Добавление новой минутной свечи
      this.candles.unshift({
        date: date,
        timestamp: timestamp,
        type: null,
        difference: 0,
        price: {},
        amount: 0,
        items: []
      })
    }

    // Отправляем данные в ожидание для покупки/продажи
    if (watch) await this.watch(price)

    // Вставляем событие в текущую свечи
    this.candles[0].items.unshift(item)

    // Расчет мин и макс
    this.candles[0].price.min = !this.candles[0].price.min
      ? price
      : (price < this.candles[0].price.min ? price : this.candles[0].price.min)

    this.candles[0].price.max = !this.candles[0].price.max
      ? price
      : (price > this.candles[0].price.max ? price : this.candles[0].price.max)

    // Объем
    this.candles[0].amount += amount
  }

  // Наблюдение за последними свечами, для выявления покупки
  async observe() {
    // Не выполняем наблюдение, если есть задача
    if (this.task !== null) return null

    try {
      if (!this.candles.length || this.candles.length < 120) {
        console.log(`Недостаточно свеч ${this.candles.length} для пары ${this.pair}`)
        return false
      }

      try {
        // Получение списка активных ордеров
        await this.activeOrders()
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
      if (lastTrade.type === 'buy' && this.task === null) {
        // Восстанавливаем процесс продажи после остановки бота 
        console.log(`Восстановление продажу после сбоя ${this.pair}`, lastTrade)

        // Минимальная сумма продажи
        const minSellPrice = this.getMarkupPrice(lastTrade.price)

        // Объем для продажи
        const amount = await this.getSellAmount()

        // Выставляем на продажу не отловленную покупку
        this.task = {
          type: 'sell',
          buyAmount: lastTrade.price,
          startAmount: amount,
          price: minSellPrice,
          minPrice: minSellPrice, // минимальная достигнутая цена
          maxPrice: minSellPrice, // максимальная, на данный момент это цена закупки
          amount: amount,// Цена продажи с вычетом коммиссии
          currentPrice: minSellPrice,
          timestamp: Date.now()
        }

        console.log('Создана задача', this.task)
        return false
      }

      // Поиск выгодного момента
      for (let item of data) {
        if (current.price.min > item.price.min) {
          return false
        }
      }

      // Курс по которому мы купим
      const minPrice = parseFloat(((current.price.min * (0.02 / 100)) + current.price.min).toFixed(8))

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

        console.log(`Достигнуто часовое дно для пары ${this.pair}`)
      }
    } catch (e) {
      console.log(`Error observe: ${e.error}`, e)
    }
  }

  // Наблюдение за активными ордерами
  async observeActiveOrders() {
    try {
      // Получение списка активных ордеров
      const activeOrders = await this.activeOrders()
      for (let id in activeOrders) {
        if (!this.orders.includes(id)) this.orders.push(id)
      }
    } catch (e) {
      // не обрабатываем
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
        this.task = null
        console.log(`Исчерпаны попытки купить ${this.pair}`)
        return false
      }

      // Курс падает, ждем дна
      if (transaction <= this.task.minPrice) {
        console.log(`Курс падает ${transaction}, минимум ${this.task.minPrice}`)
        this.task.minPrice = transaction
      } else {
        // Если цена последней транзакции выросла
        // по сравнению с минимальной ценой, а так же все еще ниже часового минимума
        if (((1 - (this.task.minPrice / transaction)) * 1000) >= 2) {
          if (((1 - (this.task.minPrice / transaction)) * 1000) >= 10) {
            console.log(`Высойкий курс ${transaction}, минимум ${this.task.minPrice}`)
            this.task.repeat--
            return false
          }

          // Цена ниже установленного минимума
          if (transaction <= this.task.price) {
            console.log(`Цена ниже установленного минимума ${transaction}, минимум ${this.task.minPrice}`)
            // Повторно проверяем
            if (this.task.bottom !== 1) {
              this.task.bottom++
              return false
            }

            try {
              // Объем покупки
              console.log(`Выгодный курс ${transaction} для покупки ${this.task.amount} ${this.pair}`)

              // Отправляем заявку на покупку
              await this.trade(transaction, this.task.amount)

              // Обнуляем задачу
              this.task = null
            } catch (e) {
              console.log('Error watch buy:', e)
            }
          }
        }
      }
    }

    // Продажа
    const sell = async () => {
      // Текущая цена ниже установленного минимума
      if (transaction < this.task.price) {
        return false
      }

      // Курс растет, ждем пика
      if (transaction > this.task.maxPrice) {
        console.log('курс растет', transaction)
        this.task.maxPrice = transaction
      } else {

        // Если цена последней транзакции снизилась
        // по сравнению с максимальной ценой, а так же все еще выше часового минимума
        if (((1 - (transaction / this.task.maxPrice)) * 1000) >= 10) {
          console.log(`Курс снижается ${this.pair}`)

          // Цена выше установленного минимума
          if (transaction >= this.task.price) {
            try {
              // Объем продажи
              console.log(`Отправляем заявку на продажу ${this.task.amount} по курсу ${transaction} ${this.pair}`)

              // Отправляем заявку на покупку
              await this.trade(transaction, this.task.amount)

              // Обнуляем задачу
              this.task = null
            } catch (e) {
              console.log('Error sell', e)
            }
          }
        }
      }
    }

    // Выполняем тип в зависимости от задачи
    this.task.type === 'buy' ? buy() : sell()
  }

  // Наблюдение за ордерами
  async observeOrders() {
    this.orders.map(async id => {
      try {
        const order = await this.orderInfo(id)

        // Если ордер отменен, удаляем его из наблюдения
        if (order.status === 2) {
          this.removeOrder(id)
          return false
        }

        // Если ордер на половину выполнен, но срок прошел
        // выставляем на продажу купленный объем
        if (order.status === 3) {

          // Объем, который мы купили
          const amount = await this.getSellAmount()

          // Оповещаем пользователя о купле
          this.sendMessage(`💰 Частично купили ${amount} ${this.pair} по курсу ${order.price}\n order_id: ${id}`)

          // Формируем минимальную цену продажи
          const markupPrice = this.getMarkupPrice(order.price)

          // Выставляем частично купленный объем на продажу
          this.task = {
            type: 'sell',
            buyAmount: order.price,
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
          this.sendMessage(`💰 Купили ${order.amount} ${this.pair} по курсу ${order.price}\n order_id: ${id}`)

          // Формируем минимальную цену продажи
          const markupPrice = this.getMarkupPrice(order.price)

          // Объем, который мы купили
          const amount = await this.getSellAmount()

          // Выставляем на продажу
          this.task = {
            type: 'sell',
            buyAmount: order.price,
            startAmount: order.amount,
            price: markupPrice,
            minPrice: markupPrice, // минимальная достигнутая цена
            maxPrice: markupPrice, // максимальная, на данный момент это цена закупки
            currentPrice: markupPrice,
            amount: amount,
            timestamp: Date.now()
          }
        } else {
          // Считаем заработок
          // const income = (this.task.amount * order.rate) - (this.task.startAmount * this.task.buyAmount)

          // Прибавляем заработок
          // this.income += income

          // Очищаем задачу
          this.task = null

          // Оповещаем о продаже
          this.sendMessage(`🎉 Продали ${order.amount} ${this.pair} по курсу ${order.price} \norder: ${id}`)
        }

        // Удаляем ордер из наблюдения
        this.removeOrder(id)

      } catch (e) {
        console.log('Error observeOrders:', e)
      }
    })
  }

  // Отмена ордера по истичению 15 минут
  async orderCancelLimit(id, order) {
    // Если ордер выполнен, пропускам проверку
    if (order.status === 1) return false

    const currentTime = Math.floor(Date.now() / 1000)

    // Если срок жизни прошел, отменяем ордер
    if (currentTime > (order.timestamp + this.config.timeOrder)) {
      try {
        // Отмена ордера
        await this.cancelOrder(id)
        return true
      } catch (e) {
        console.log(`Error orderCancelLimit:`, e)
      }
    }
    // Срок ордера еще не окончен
    return false
  }

  	// Получаем объем для продажи
	async getSellAmount() {
    const wallets = await this.getWallets()
    return this.getCurrentAmount(wallets[this.purseSell])
  }
  
  // Данные кошелька
	async getBalance() {
		const wallets = await this.getWallets()
		const data = []
		for (let item in wallets) {
			data.push({ type: item, value: wallets[item] })
		}
		return data
  }

  // Получаем объем исходя из курса и суммы денег
  async buyAmount(rate) {
    try {
      const wallets = await this.getWallets()
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
        return this.getCurrentAmount(parseFloat((wallets[this.purseBuy] / rate)))
      } else {
        // Разделяем на части
        return this.getCurrentAmount(parseFloat(((wallets[this.purseBuy] / distribution.length) / rate)))
      }
    } catch (e) {
      console.log('Error buyAmount', e.error)
    }
  }

  getCurrentAmount (amount) {
    const [ceil] = amount.toString().split('.')
    const [, remainder] = amount.toString().split('.')
    return parseFloat([ceil, remainder.substr(0, this.decimial)].join('.'))
  }

  async getHistory() {
    try {
      const history = await this.getHistoryApi()
      const data = []

      for (let item in history) {
        data.push(history[item])
      }
      return data
    } catch (e) {
      console.log('Error getHistory', e)
    }
  }

  /** API */

  // Получаем данные кошелька
  getBalance() { }

  // Активные ордеры
  activeOrders() { }

  // Последняя транзакция
  lastTransaction() { }

  // Получаем данные кошелька
  getWallets() { }

  // Метод для покупок/продажи
  trade() { }

  // Получение информации об ордере
  orderInfo() { }

  // Отмена ордера
  cancelOrder() { }
  
  // Получаем историю
  getHistoryApi () { }
}

module.exports = Base