const net = require('net')
const crypto = require('crypto')
const zlib = require('zlib')

const hex = require('hex')
const debug = require('debug')('slsk:i')

const Message = require('./message.js')
const Messages = require('./messages.js')

let client
let stack = {
  search: {}
}
let peers = []

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
    stack.search[token] = {
      cb: res => {
        results.push(res)
      },
      query: obj.req
    }

    client.write(msg.getBuff())
  }
}

let rest

function initClient(cb) {
  debug('Init client')
  client = net.createConnection({
    host: 'server.slsknet.org',
    port: 2242
  }, cb)
  client.on('data', data => {
    debug('data')
    hex(data)
    let msgs = new Messages(data, rest)
    rest = msgs.rest
    msgs.forEach(msg => {
      let size = msg.int32()
      debug(`srv size: ${size}`)
      if (size < 4) return
      let code = msg.int32()
      switch (code) {
        case 1: {
          if (!stack.login) return
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
        case 18: {
          connectToPeer(msg)
          break
        }
        default: {
          debug(`unknown message code ${code}`)
        }
      }
    })
  })
}

function connectToPeer(msg) {
  //hex(msg.data)
  let user = msg.str()
  let type = msg.str()
  let ip = []
  for (let i = 0 ; i < 4 ; i++) {
    ip.push(msg.int8())
  }
  let host = ip[3] + '.' + ip[2] + '.' + ip[1] + '.' + ip[0]
  let port = msg.int32()
  let token = msg.readRawHexStr(4)
  debug(`connectToPeer ${user} ${host} ${port} ${token}`)

  let conn = net.createConnection({
    host,
    port
  }, () => {
    let buf = Buffer.from('05' + '00000000' + token, 'hex')
    conn.write(buf)
  })

  conn.on('error', error => {
    debug(`${user} error ${error.code}`)
  })

  conn.on('data', data => {
    debug(`${user} data`)
    let msgs = new Messages(data)
    msgs.forEach(msg => {
      let size = msg.int32()
      let code = msg.int32()
      switch (code) {
        case 9: {
          //This command use zlib for communication, we must decompress it before using it
          let content = msg.data.slice(msg.pointer, size + 4)
          zlib.unzip(content, (err, buffer) => {
            if (err) {
              debug(err)
              return
            }
            //hex(buffer)
            msg = new Message(buffer)
            let currentUser = msg.str()
            let currentToken = msg.rawHexStr(4)
            let nbFiles = msg.int32()
            debug(`${currentUser} nbFiles: ${nbFiles}`)
            let files = []
            for (let i = 0 ; i < nbFiles ; i++) {
              let code = msg.int8()
              let filename = msg.str()
              let filesize = msg.int32()
              let filesize2 = msg.int32()
              let ext = msg.str()
              let nbAttrib = msg.int32()
              msg.seek(nbAttrib * 8)
              debug(`${filename} ${filesize}`)
              files.push({
                user: currentUser,
                file: filename,
                size: filesize
              })
            }
            let slots = msg.int8()
            if (stack.search[currentToken]) {
              files.forEach(file => {
                stack.search[currentToken].cb({
                  user: file.user,
                  file: file.file,
                  size: file.size,
                  slots
                })
              })
            }
          })
          break
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
