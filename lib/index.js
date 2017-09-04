const net = require('net')
const crypto = require('crypto')

const hex = require('hex')
const debug = require('debug')('slsk')

const Message = require('./message.js')
const Messages = require('./messages.js')

let client
let stack = {
  search: {}
}

module.exports = {
  connect: (obj, cb) => {
    initClient(() => {
      let timeout = obj.timeout || 2000
      setTimeout(() => {
        if (stack.login) {
          delete stack.login
          cb(new Error('timeout login'))
        }
      }, timeout)
      login(obj, err => {
        if (err) return cb(err)
        cb(null, new SlskClient())
      })
    })
  },
  disconnect: () => {
    client.destroy()
  }
}

class SlskClient {
  constructor() {

  }

  search(obj, cb) {
    let msg = new Message()
    let token = crypto.randomBytes(4).toString('hex')
    msg.int32(26) //code
      .rawHexStr(token) //token as int
      .str(obj.req) //req

    let timeout = obj.timeout || 4000
    let results = []
    setTimeout(() => {
      delete stack.search[token]
      cb(null, results)
    }, timeout)
    stack.search[token] = res => {
      results.push(res)
    }

    client.write(msg.getBuff())
  }
}

function initClient(cb) {
  debug('Init client')
  client = net.createConnection({
    host: 'server.slsknet.org',
    port: 2242
  }, cb)
  client.on('data', data => {
    debug('data')
    //hex(data)
    let msgs = new Messages(data)
    msgs.forEach(msg => {
      let size = msg.int32()
      let code = msg.int32()
      switch (code) {
        case 1: {
          let success = msg.int8()
          if (success === 1) {
            hex(msg.data)
            stack.login()
            delete stack.login
          } else {
            let reason = msg.str()
            stack.login(new Error(reason))
            delete stack.login
          }
          break
        }
        default: {
          debug(`unknown message code ${code}`)
        }
      }
    })
  })
}

function login(obj, cb) {
  let msg = new Message()
  msg.int32(1) //code
    .str(obj.user) //user
    .str(obj.pass) //pass
    .int32(157) //version
    .str(crypto.createHash('md5').update(obj.user + obj.pass).digest('hex')) //hash
    .int32(17) //?
    .int32(8) //?
    .int32(2) //?
    .int32(47624) //?
  client.write(msg.getBuff())
  stack.login = cb
}
