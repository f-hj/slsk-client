const EventEmitter = require('events')
const MessageFactory = require('../message-factory.js')
const debug = require('debug')('slsk:peer:i')

module.exports = class Peer extends EventEmitter {
  constructor (socket, peer) {
    super()
    this.conn = socket
    this.peer = peer

    this.conn.on('error', error => {
      debug(`${peer.user} error ${error.code}`)
      this.emit('disconnect', {})
    })

    this.conn.on('end', () => {
      debug(`${peer.user} connection ended`)
      this.emit('disconnect', {})
    })
  }

  transferRequest (file, token) {
    debug(`Transfer request ${file}`)
    this.conn.write(MessageFactory
      .to.peer
      .transferRequest(file, token)
      .getBuff())
  }

  setAddress (host, port) {
    debug(`setAddress for ${this.peer.user}: ${host} ${port}`)
    this.peer.host = host
    this.peer.port = port
  }

  fileSearchResult (files, token, user) {
    debug(`send FileSearchResult to user ${this.peer.user} with token ${token}`)
    this.conn.write(
      MessageFactory
        .to.peer
        .fileSearchResult(files, token, user)
        .getBuff()
    )
  }

  destroy () {
    this.conn.destroy()
  }
}
