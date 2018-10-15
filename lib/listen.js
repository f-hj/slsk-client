const EventEmitter = require('events')
const net = require('net')
const zlib = require('zlib')
const Messages = require('./messages.js')
const MessageFactory = require('./message-factory.js')
const debug = require('debug')('slsk:listen:i')

let stack = require('./stack')

module.exports = class Listen extends EventEmitter {
  constructor (port) {
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
                user: user
              })
              break
            }
            default: {
              debug(`unattended case.`)
            }
          }
          return
        }

        let code = msg.int32()
        switch (code) {
          case 9: {
            debug(`recv FileSearchResult size ${size}`)
            // This command use zlib for communication, we must decompress it before using it
            let content = msg.data.slice(msg.pointer, size + 4)
            zlib.unzip(content, (err, buffer) => {
              if (err) {
                debug(err)
                return
              }

              let result = MessageFactory.from.peer.fileSearchResult(buffer)

              if (stack.search[result.currentToken]) {
                result.files.forEach(file => {
                  stack.search[result.currentToken].cb({
                    user: file.user,
                    file: file.file,
                    size: file.size,
                    slots: result.slots === 1,
                    bitrate: file.attribs ? file.attribs[0] : undefined,
                    speed: result.speed
                  })
                })
              }
            })
            break
          }
          default: {
            debug(`unknown listen message code ${code} size ${size}`)
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
