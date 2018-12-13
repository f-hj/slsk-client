const EventEmitter = require('events')
const net = require('net')
const zlib = require('zlib')
const Messages = require('../lib/messages.js')
const MessageFactory = require('../lib/message-factory.js')
const debug = require('debug')('slsk:mock:peer:default:i')

module.exports = class MockDefaultPeer extends EventEmitter {
  constructor (address) {
    super()

    this.server = net.createServer(client => {
      debug(`Peer connected`)
      let msgs = new Messages()

      client.on('data', data => {
        msgs.write(data)
      })

      msgs.on('message', msg => {
        let size = msg.int32()
        if (size < 4) return
        let code = msg.int32()
        switch (code) {
          case 9:
            debug(`recv FileSearchResult`)
            let content = msg.data.slice(msg.pointer, size + 4)
            zlib.unzip(content, (err, buffer) => {
              if (err) {
                debug(err)
                return
              }

              this.emit('file-search-result', MessageFactory.from.peer.fileSearchResult(buffer))
            })
            break
          default:
            debug(`unknown default peer message code: ${code}`)
        }
      })
    })

    this.server.on('error', err => {
      debug(`Error ${err.code}`)
    })

    this.server.listen(address.port, address.host, () => {
      debug(`MockDefaultPeer bound on ${address.host}:${address.port}`)
    })
  }

  destroy () {
    this.server.close()
  }
}
