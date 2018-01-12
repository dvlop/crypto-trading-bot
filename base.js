const config = require('./conf')
const moment = require('moment')

class Base {
  constructor({ api, pair, percentWallet, telegram, purse, commission = 0.2, markup = 1 } = {}) {
    // Доступы к API
    this.api = config.api[api]

    // Кошелек
    this.purse = purse

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
  }

  // Инициализация
  init() {
    // Заносим активные ордеры в массив
    // setInterval(() => this.observeActiveOrders(), 1000)

    // Наблюдение за ордерами
    // setInterval(() => this.observeOrders(), 1000)

    // Отслеживать каждую минуту ситуацию на рынке
    // setInterval(() => this.observe(), 60000)

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
    return parseFloat(((rate * ((this.markup + (this.commission * 2)) / 100)) + rate).toFixed(3))
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
      if (lastTrade.type === 'buy' || this.task !== null) {
        // Восстанавливаем процесс продажи после остановки бота

        // Минимальная сумма продажи
        const minSellPrice = this.getMarkupPrice(lastTrade.prie)

        // Объем для продажи
        const amount = await this.getSellAmount()

        // Выставляем на продажу не отловленную покупку
        this.task = {
          type: 'sell',
          buyAmount: lastTrade.prie,
          startAmount: lastTrade.amount,
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
      console.log('Error observeActiveOrders', e.error)
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
        return false
      }

      // Курс падает, ждем дна
      if (transaction <= this.task.minPrice) {
        this.task.minPrice = transaction
      } else {
        // Если цена последней транзакции выросла
        // по сравнению с минимальной ценой, а так же все еще ниже часового минимума
        if (((1 - (this.task.minPrice / transaction)) * 1000) >= 2) {
          if (((1 - (this.task.minPrice / transaction)) * 1000) >= 4) {
            this.task.repeat--
            return false
          }

          // Цена ниже установленного минимума
          if (transaction <= this.task.price) {
            // Повторно проверяем
            if (this.task.bottom !== 1) {
              this.task.bottom++
              return false
            }

            try {
              // Объем покупки
              const amount = parseFloat(this.task.amount).toFixed(8)

              // Отправляем заявку на покупку
              await this.trade(transaction, amount)

              // Обнуляем задачу
              this.task = null
            } catch (e) {
              console.log('Error watch buy:', e.error)
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
        this.task.maxPrice = transaction
      } else {

        // Если цена последней транзакции снизилась
        // по сравнению с максимальной ценой, а так же все еще выше часового минимума
        if (((1 - (transaction / this.task.maxPrice)) * 1000) >= 3) {

          // Цена выше установленного минимума
          if (transaction >= this.task.price) {
            try {
              // Объем продажи
              const amount = parseFloat(this.task.amount).toFixed(8)

              // Отправляем заявку на покупку
              await this.trade(transaction, amount)

              // Обнуляем задачу
              this.task = null
            } catch (e) {
              console.log('Error sell', e.error)
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
          this.sendMessage(`💰 Частично купили ${amount} ${this.pair} из ${order.amount} по курсу ${order.price}\n order_id: ${id}`)

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
          this.sendMessage(`🎉 Продали ${order.start_amount} ${this.pair} по курсу ${order.price} \norder: ${id}`)
        }

        // Удаляем ордер из наблюдения
        this.removeOrder(id)

      } catch (e) {
        console.log('Error observeOrders:', e.error)
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
        console.log(`Error orderCancelLimit:`, e.error)
      }
    }
    // Срок ордера еще не окончен
    return false
  }

  /** API */

  // Получаем данные кошелька
  getBalance() { }

  // Получаем историю сделок
  getHistory() { }

  // Активные ордеры
  activeOrders() { }

  // Последняя транзакция
  lastTransaction() { }

  // Получаем объем для продажи
  getSellAmount() { }

  // Получаем данные кошелька
  getWallets() { }

  // Получаем объем исходя из курса и суммы денег
  buyAmount() { }

  // Метод для покупок/продажи
  trade() { }

  // Получение информации об ордере
  orderInfo() { }

  // Отмена ордера
  cancelOrder() { }
}

module.exports = Base