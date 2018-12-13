const EventEmitter = require('events')
const net = require('net')
const Messages = require('../lib/messages.js')
const Message = require('../lib/message.js')
const debug = require('debug')('slsk:mock:server:i')

module.exports = class MockServer extends EventEmitter {
  constructor (address) {
    super()

    this.server = net.createServer(client => {
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
          case 2:
            let port = msg.int32()
            debug(`recv SetWaitPort ${port}`)
            break
          case 3:
            let user = msg.str()
            debug(`recv getPeerAddress for user ${user}`)
            this.emit('get-peer-address', { client, user })
            break
          case 71:
            let flag = msg.int8()
            debug(`recv HaveNoParent message: ${flag}`)
            if (flag) {
              this.emit('have-no-parent', { client })
            }
            break
          default:
            debug(`unknown srv message code: ${code}`)
        }
      })
    })

    this.server.on('error', err => {
      debug(`Error ${err.code}`)
    })

    this.server.listen(address.port, address.host, () => {
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

  netInfo (client, user, host, port) {
    client.write(
      netInfo(user, host, port).getBuff()
    )
  }

  returnPeerAddress (client, user, host, port) {
    let ip = host.split('.')
    client.write(
      new Message()
        .int32(3)
        .str(user)
        .int8(parseInt(ip[3]))
        .int8(parseInt(ip[2]))
        .int8(parseInt(ip[1]))
        .int8(parseInt(ip[0]))
        .int32(port)
        .getBuff()
    )
  }

  destroy () {
    this.server.close()
  }
}

function loginResponse (status, message) {
  return new Message()
    .int32(1)
    .int8(status)
    .str(message)
}

function netInfo (user, host, port) {
  let ip = host.split('.')
  return new Message()
    .int32(102)
    .int32(1)
    .str(user)
    .int8(parseInt(ip[3]))
    .int8(parseInt(ip[2]))
    .int8(parseInt(ip[1]))
    .int8(parseInt(ip[0]))
    .int32(port)
}
