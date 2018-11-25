const EventEmitter = require('events')
const net = require('net')
const Messages = require('../lib/messages.js')
const Message = require('../lib/message.js')
const debug = require('debug')('slsk:mock:peer:distributed:i')

module.exports = class MockDistributedPeer extends EventEmitter {
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
        let code = msg.int8()
        switch (code) {
          case 1:
            let user = msg.str()
            let type = msg.str()
            let token = msg.readRawHexStr(4)
            debug(`recv PeerInit user ${user}, type ${type}, token ${token}`)
            this.emit('peer-init', { client, token })
            break
          default:
            debug(`unknown distributed peer message code: ${code}`)
        }
      })
    })

    this.server.on('error', err => {
      debug(`Error ${err.code}`)
    })

    this.server.listen(address.port, address.host, () => {
      debug(`MockDistributedPeer bound on ${address.host}:${address.port}`)
    })
  }

  searchRequest (client, user, ticket, query) {
    client.write(
      searchRequest(user, ticket, query).getBuff()
    )
  }

  destroy () {
    this.server.close()
  }
}

function searchRequest (user, ticket, query) {
  return new Message()
    .int8(3)
    .int32(39)
    .str(user)
    .rawHexStr(ticket)
    .str(query)
}
