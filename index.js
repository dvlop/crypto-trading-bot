const config = require('./config')
const db = require('./db')
const BTCE = require('btce')
const TelegramBot = require('node-telegram-bot-api')

// MongoDB модели
const models = require('./model')

// Инициализация соединения
const btce = new BTCE(config.key, config.secret)

// Инициализация бота
const bot = new TelegramBot(config.token, {polling: true})

// Валюта
const pair = 'btc_usd'

// Вся история движения
const history = []

// Свечи
const candles = []

let segment = null

// Кошельки
let wallet = null

// Объем преобритаемых btc
const amount = 0.001

// Количество начально загружаемых транзакций
let elements = 500

// Получаем данные кошельков
btce.getInfo((err, res) => {
  if (err) throw new Error(err)

  // Кошелек
  wallet = res.return.funds

  btce.ticker({pair: pair}, (err, res) => {
    if (err) throw new Error(err)
    const ticker = res.ticker

    setInterval(() => trades(), 1000)
  })
})

// Формирование структурированных данных купли/продажи
const trades = () => {
  btce.trades({count: elements, pair: pair}, (err, res) => {
    if (err) throw new Error(err)
    for (let item of res.reverse()) {
      // Пропускаем повторы
      if (findHistory(item.tid)) continue

      // Добавляем элемент в историю
      history.unshift(item)

      let date = new Date(item.date * 1000)
      if (segment === null || segment !== date.getMinutes()) {
        segment = date.getMinutes()

        // Добавление новой минутной свечи
        candles.unshift({
          date: date,
          timestamp: item.date,
          type: null,
          difference: 0,
          price: {},
          amount: 0,
          items: []
        })
      }

      // Вставляем событие в текущую свечи
      candles[0].items.unshift(item)

      // Расчет мин и макс
      candles[0].price.min = !candles[0].price.min
        ? item.price
        : (item.price < candles[0].price.min ? item.price : candles[0].price.min)

      candles[0].price.max = !candles[0].price.max
        ? item.price
        : (item.price > candles[0].price.max ? item.price : candles[0].price.max)

      // Объем
      candles[0].amount += item.amount
    }

    // Уменьшаем до 75 кол. новых данных
    elements = 100
  })
}

const findHistory = (tid) => {
  for (item of history) {
    if (tid === item.tid) return true
  }
  return false
}

// Активные ордеры
const activeOrders = () => new Promise((resolve, reject) => {
  btce.activeOrders({pair: pair}, (err, res) => {
    resolve(res)
  })
})

// Получаем данные о ордере
const getActiveOrders = () => new Promise(async (resolve, reject) => {
  let order = await models.Order.findOne({status: false})
  if (order === null) {
    reject('Нет активных ордеров')
    return false
  }

  btce.orderInfo({order_id: order.id}, (err, res) => {
    if (err) {
      reject(err)
      return false
    }
    resolve(res)
  })
})

// Наблюдение за ордерами и изменение типа покупки (buy/sell)
const observeActiveOrders = async () => {
  try {
    let order = await getActiveOrders()

    // Ордер завершен
    if (order.return.status === 1){

      // Ордер выполнен, помечаем как выполненный
      models.Order.update({
        id: order.id
      }, {
        $set: true
      })

      // Сообщаем боту, что пора выставлять на продажу

    }
  } catch (e) {
    console.log(e)
  }
}

// Наблюдение за последними свечами, для выявления покупки или продажи
const observe = async () => {
  try {
    if (!candles.length) return false

    // Получение списка активных ордеров
    try {
      let order = await getActiveOrders()
      console.log('есть активное задание')
      console.log(order)

      // Есть активный ордер, ожидаем завершения
      return false
    } catch (e) {
      // Не обрабатываем исключение,
      // так как нас устраивает отсутствие ордера
    }

    console.log('дальше пошел.....')

    // Получаем последние свечи
    let data = candles.filter((item, index) => index <= 30)

    let type = 'buy'

    // Необходимо проанализировать данные и решить купить или продать
    if (type === 'buy') {

      // Текущая обстановка на рынке
      let current = data.shift()

      // Состояние
      let state = false

      // Поиск выгодного момента
      data.map(item => {
        if (current.price.min < item.price.min) {
          state = true
        }
      })

      if (state) {

        // Покупаем
        btce.trade({
          pair: 'btc_usd',
          type: 'sell',
          rate: 2700,
          amount: amount
        }, (err, res) => {
          if (err) {
            console.log(err)
            bot.sendMessage(config.user, `Ошибка trade: ${err}`)
            return false
          }

          new models.Order({
            id: res.return.order_id,
            type: 'sell',
            pair: pair,
            rate: 2700,
            amount: amount
          }).save()

          // Оповещаем об покупке
          bot.sendMessage(config.user, `⌛ Запрос на покупку ${amount} BTC по курсу ${current.price.min}`)

          // bot.sendMessage(config.user, `💰 Купили ${amount} BTC по курсу ${current.price.min}`)
        })

      } else {
        console.log('Не выгодно')
      }
    } else if (type === 'sell') {

    }
  } catch (e) {
    console.log('trade observe ' + e)
  }
}

// Отслеживать каждую минуту ситуацию на рынке
setInterval(() => observe(), 10000)

// Отслеживание завершения сделок
setInterval(() => observeActiveOrders(), 1000)
