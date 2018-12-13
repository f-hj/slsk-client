const Peer = require('./peer.js')
const Messages = require('../messages.js')
const MessageFactory = require('../message-factory.js')
const debug = require('debug')('slsk:peer:distributed:i')

let stack = require('../stack')

module.exports = class DistributedPeer extends Peer {
  constructor (socket, peer) {
    super(socket, peer)

    this.conn.on('connect', () => {
      if (peer.token) {
        this.conn.write(MessageFactory
          .to.peer
          .peerInit(peer.user, peer.type, peer.token)
          .getBuff())
        let buf = Buffer.from('05000000' + '00' + peer.token, 'hex')
        this.conn.write(buf)
      }
    })

    let msgs = new Messages()

    this.conn.on('data', data => {
      msgs.write(data)
    })

    msgs.on('message', msg => {
      let size = msg.int32()
      if (size <= 4) return

      let code = msg.int8()
      switch (code) {
        case 3: {
          msg.int32() // unknown field
          let user = msg.str()
          let ticket = msg.readRawHexStr(4)
          let query = msg.str()
          let searchKey = `${user}_${ticket}_${query}`
          if (stack.peerSearchRequests.indexOf(searchKey) === -1) {
            stack.peerSearchRequests.push(searchKey)
            debug(`${peer.user} Search Request from ${user}, ticket ${ticket}. query: ${query}`)
            this.emit('search', { user, ticket, query })
          }
          break
        }
        case 4: {
          let branchLevel = msg.int32()
          debug(`${peer.user} Branch Level ${branchLevel}`)
          break
        }
        case 5: {
          let branchRoot = msg.str()
          debug(`${peer.user} Branch Root ${branchRoot}`)
          break
        }
        default: {
          debug(`${peer.user} unknown distributed message code ${code}`)
        }
      }
    })
  }
}
