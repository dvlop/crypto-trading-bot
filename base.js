// const telegram = require('./libs/telegram')
const config = require('./conf')
const colors = require('colors')
const moment = require('moment')

class Base {
  constructor({ api, pair, percentWallet, telegram, commission = 0.2, markup = 1 } = {}) {
    // Доступы к API
    this.api = config.api[api]

    // Кошелек
    this.purse = api

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

  // Вывод в консоль с текущим временем
  console(text, params = '') {
    console.log(`${text}`, params, `[${moment().format('LLL')}]`)
  }

  // Поиск в истории транзакций
  findHistory(tid) {
    for (let item of this.history) {
      if (tid === item.tid) return true
    }
    return false
  }

  // Удаление ордера
  removeOrder(id) {
    for (let key in this.orders) {
      if (this.orders[key] === id) {
        this.orders.splice(key, 1)
      }
    }
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

  // Получаем данные кошелька
  getBalance () {
    // Реализовать во всех дочерних объектах
  }

  // Получаем историю сделок
  getHistory () {
    // Реализовать во всех дочерних объектах
  }

  // Активные ордеры
  activeOrders () {

  }

  // Последняя транзакция
  lastTransaction () {

  }
}

module.exports = Base