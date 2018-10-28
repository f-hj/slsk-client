const EventEmitter = require('events')
const net = require('net')
const Messages = require('../../lib/messages.js')
const Message = require('../../lib/message.js')
// const MessageFactory = require('./message-factory.js')
const debug = require('debug')('slsk:mock-server:i')

module.exports = class Server extends EventEmitter {
  constructor (address) {
    super()

    let server = net.createServer(client => {
      debug(`Client connected`)
      let msgs = new Messages()

      client.on('data', data => {
        msgs.write(data)
      })

      msgs.on('message', msg => {
        let size = msg.int32()
        if (size < 4) return
        let code = msg.int32()
        switch (code) {
          case 1:
            let username = msg.str()
            let password = msg.str()
            let version = msg.int32()
            debug(`Login attempt username ${username} version ${version}`)
            this.emit('login', { client, username, password, version })
            break
          default:
            throw new Error(`unknown srv message code: ${code}`)
        }
      })
    })

    server.on('error', err => {
      debug(`Error ${err.code}`)
    })

    server.listen(address.port, address.host, () => {
      debug(`MockServer bound on ${address.host}:${address.port}`)
    })
  }

  loginSuccess (client) {
    client.write(
      loginResponse(1, 'Login Success').getBuff()
    )
  }

  loginFail (client) {
    client.write(
      loginResponse(0, 'INVALIDPASS').getBuff()
    )
  }
}

function loginResponse (status, message) {
  return new Message()
    .int32(1)
    .int8(status)
    .str(message)
}
