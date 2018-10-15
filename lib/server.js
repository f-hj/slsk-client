const EventEmitter = require('events')
const net = require('net')
const Messages = require('./messages.js')
const MessageFactory = require('./message-factory.js')
const debug = require('debug')('slsk:server:i')

let stack = require('./stack')

module.exports = class Server extends EventEmitter {
  constructor (cb) {
    super()
    this.conn = net.createConnection({
      host: 'server.slsknet.org',
      port: 2242
    }, cb)

    let msgs = new Messages()

    this.conn.on('error', err => {
      cb(new Error(err.message))
    })

    this.conn.on('data', data => {
      msgs.write(data)
    })

    msgs.on('message', msg => {
      let size = msg.int32()
      if (size < 4) return
      let code = msg.int32()
      switch (code) {
        case 1: {
          debug(`Login Response`)
          if (!stack.login) return
          let success = msg.int8()
          if (success === 1) {
            stack.login()
            delete stack.login
            debug(`send SharedFoldersFiles`)
            this.conn.write(MessageFactory
              .to.server
              .sharedFoldersFiles(0, 0)
              .getBuff())
          } else {
            let reason = msg.str()
            stack.login(new Error(reason))
            delete stack.login
          }
          break
        }
        case 3: {
          debug(`recv GetPeerAddress`)
          let user = msg.str()
          let ip = []
          for (let i = 0; i < 4; i++) {
            ip.push(msg.int8())
          }
          let host = ip[3] + '.' + ip[2] + '.' + ip[1] + '.' + ip[0]
          let port = msg.int32()
          this.emit('get-peer-address', { user, host, port })
          break
        }
        case 18: {
          debug(`recv ConnectToPeer`)
          let user = msg.str()
          let type = msg.str()
          let ip = []
          for (let i = 0; i < 4; i++) {
            ip.push(msg.int8())
          }
          let host = ip[3] + '.' + ip[2] + '.' + ip[1] + '.' + ip[0]
          let port = msg.int32()
          let token = msg.readRawHexStr(4)
          this.emit('connect-to-peer', { user, type, ip, host, port, token })
          break
        }
        case 64: {
          debug(`recv RoomList ${msg.data.length}`)
          let nbRooms = msg.int32()
          let rooms = []
          for (let i = 0; i < nbRooms; i++) {
            rooms.push({
              name: msg.str()
            })
          }
          for (let i = 0; i < nbRooms; i++) {
            rooms[i].users = msg.int32()
          }
          break
        }
        case 69: {
          let number = msg.int32()
          debug(`there are ${number} PrivilegedUsers. msg length: ${msg.data.length}`)
          break
        }
        case 83: {
          let number = msg.int32()
          debug(`ParentMinSpeed is ${number}. msg length: ${msg.data.length}`)
          break
        }
        case 84: {
          let number = msg.int32()
          debug(`ParentSpeedRatio is ${number}. msg length: ${msg.data.length}`)
          break
        }
        case 104: {
          let number = msg.int32()
          debug(`Whishlist interval is ${number}. msg length: ${msg.data.length}`)
          break
        }
        default: {
          debug(`unknown srv message code: ${code} length: ${msg.data.length}`)
          if (code > 1002) {
            msgs.reset()
          }
        }
      }
    })
  }

  login (credentials) {
    this.conn.write(MessageFactory
      .to.server
      .login(credentials).getBuff())
  }

  fileSearch (query, token) {
    debug(`send FileSearch: ${query}`)
    this.conn.write(MessageFactory
      .to.server
      .fileSearch(query, token)
      .getBuff())
  }

  setWaitPort (port) {
    debug(`send SetWaitPort ${port}`)
    this.conn.write(MessageFactory
      .to.server
      .setWaitPort(port)
      .getBuff())
  }

  getPeerAddress (username) {
    debug(`send GetPeerAddress ${username}`)
    this.conn.write(MessageFactory
      .to.server
      .getPeerAddress(username)
      .getBuff())
  }

  destroy () {
    this.conn.destroy()
  }
}
