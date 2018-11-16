const EventEmitter = require('events')
const net = require('net')
const crypto = require('crypto')
const Messages = require('./messages.js')
const MessageFactory = require('./message-factory.js')
const debug = require('debug')('slsk:server:i')

let stack = require('./stack')

module.exports = class Server extends EventEmitter {
  constructor (serverAddress, cb) {
    super()
    this.conn = net.createConnection(serverAddress, cb)

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
            let greet = msg.str()
            debug(`Login succeed: ${greet}`)
            debug(`send SharedFoldersFiles`)
            this.conn.write(MessageFactory
              .to.server
              .sharedFoldersFiles(1, 1)
              .getBuff())
            debug(`send Have No Parents 1`)
            this.conn.write(MessageFactory
              .to.server
              .haveNoParents(1)
              .getBuff())
            debug(`send SetStatus online`)
            this.conn.write(MessageFactory
              .to.server
              .setStatus(2)
              .getBuff())
          } else {
            let reason = msg.str()
            stack.login(new Error(reason))
            delete stack.login
          }
          break
        }
        case 3: {
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
        case 7: {
          let user = msg.str()
          let status = msg.int32()
          debug(`recv GetUserStatus for ${user}: ${status}`)
          break
        }
        case 18: {
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
        case 36: {
          let user = msg.str()
          let avgSpeed = msg.int32()
          let downloadNum = msg.int32()
          let something = msg.int32()
          let files = msg.int32()
          let folders = msg.int32()
          debug(`recv GetUserStats user: ${user}, avgSpeed ${avgSpeed}, files ${files}, folders ${folders}. downloadNum ${downloadNum}. something... ${something}`)
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
        case 102: {
          let numberOfParents = msg.int32()
          debug(`recv NetInfo, number of search parents: ${numberOfParents}`)
          for (let i = 0; i < numberOfParents; i++) {
            let user = msg.str()
            let ip = []
            for (let i = 0; i < 4; i++) {
              ip.push(msg.int8())
            }
            let host = ip[3] + '.' + ip[2] + '.' + ip[1] + '.' + ip[0]
            let port = msg.int32()
            debug(`Parent ${user} ${host} ${port}`)
            this.conn.write(MessageFactory
              .to.server
              .parentIp(ip)
              .getBuff())
            this.emit('connect-to-peer', { user, type: 'D', ip, host, port, token: crypto.randomBytes(4).toString('hex') })
          }
          break
        }
        case 104: {
          let number = msg.int32()
          debug(`Whishlist interval is ${number}. msg length: ${msg.data.length}`)
          break
        }
        case 1001: {
          let token = msg.readRawHexStr(4)
          debug(`Cannot connect to peer, token ${token}`)
          break
        }
        default: {
          debug(`unknown srv message code: ${code} length: ${msg.data.length}`)
        }
      }
    })
  }

  login (credentials) {
    this.conn.write(MessageFactory
      .to.server
      .login(credentials)
      .getBuff())
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
