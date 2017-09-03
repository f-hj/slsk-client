const net = require('net')
const crypto = require('crypto')

const hex = require('hex')
const debug = require('debug')('slsk')

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
  }
}

class SlskClient {
  constructor() {

  }

  search(obj, cb) {
    let token = crypto.randomBytes(4).toString('hex')
    let req = Buffer.from(obj.req, 'utf8').toString('hex')
    let sReq = req.length / 2
    //                      length      code        token   l req       req
    let buf = Buffer.from('15000000' + '1a000000' + token + '09000000' + req, 'hex')
    buf.writeUInt32LE(8 + sReq, 0)
    buf.writeUInt32LE(sReq, 12)

    let timeout = obj.timeout || 2000
    let results = []
    setTimeout(() => {
      delete stack.search[token]
      cb(null, results)
    }, timeout)
    stack.search[token] = res => {
      results.push(res)
    }

    client.write(buf)
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
    hex(data)
    let pointer = 0
    let size = data.readUInt32LE(pointer)
    pointer += 4
    let code = data.readUInt32LE(pointer)
    pointer += 4
    if (code === 1) {
      let success = data.readUInt8(pointer)
      pointer += 1
      if (success === 1) {
        stack.login()
        delete stack.login
      } else {
        let sReason = data.readUInt32LE(pointer)
        pointer += 4
        let reason = data.toString('utf8', pointer, pointer + sReason)
        stack.login(new Error(reason))
        delete stack.login
      }
    }
  })
}

function login(obj, cb) {
  let user = Buffer.from(obj.user, 'utf8').toString('hex')
  let sUser = user.length / 2
  let pass = Buffer.from(obj.pass, 'utf8').toString('hex')
  let sPass = pass.length / 2
  let hash = Buffer.from(crypto.createHash('md5').update(obj.user + obj.pass).digest('hex'), 'utf8').toString('hex')
  //                      length       code         l user     user   l pass        pass   version
  let buf = Buffer.from('00000000' + '01000000' + '00000000' + user + '00000000' + pass + '9d000000' +
  // l hash     hash   version      (rest in sending by nicotine+, don't know what is it, never change)
  '20000000' + hash + '11000000' + '08000000' + '02000000' + 'ba080000', 'hex')
  buf.writeUInt32LE(sUser, 8)
  buf.writeUInt32LE(sPass, 12 + sUser)
  buf.writeUInt32LE(36 + sUser + sPass + 32, 0)
  hex(buf)
  client.write(buf)
  stack.login = cb
}
