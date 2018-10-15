const EventEmitter = require('events')
const net = require('net')
const Messages = require('./messages.js')
const debug = require('debug')('slsk:listen:i')

module.exports = class Listen extends EventEmitter {
  constructor () {
    super()

    this.socket = net.createServer((c) => {
      let user
      let msgs = new Messages()
      c.on('data', chunk => {
        msgs.write(chunk)
      })

      c.on('error', err => {
        debug(`listen connection error ${err.code}`)
      })

      msgs.on('message', msg => {
        let size = msg.int32()
        if (size < 4) return

        if (!user) {
          let code = msg.int8()
          switch (code) {
            case 0: {
              let token = msg.int32()
              debug(`recv Perce Firewall, token: ${token}`)
              break
            }
            case 1: {
              user = msg.str()
              let type = msg.str()
              let token = msg.int32()
              debug(`peerInit ${user}, type ${type}, token ${token}`)
              this.emit('new-peer', {
                socket: c,
                peer: { user, type, token }
              })
              break
            }
            default: {
              debug(`unattended case.`)
            }
          }
        }
      })

      c.on('end', () => {
        debug('client disconnected')
      })
    })
  }

  start (port, connectionListener) {
    this.socket.on('error', err => {
      debug(`Error ${err}`)
    })

    this.socket.listen(port, '0.0.0.0', () => {
      debug(`Listen peer connections on port ${port}`)
    })
  }

  destroy () {
    this.conn.destroy()
  }
}
