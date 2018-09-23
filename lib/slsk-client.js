const EventEmitter = require('events')

const net = require('net')
const crypto = require('crypto')
const zlib = require('zlib')
const stream = require('stream')

const debug = require('debug')('slsk:i')
const debugPeer = require('debug')('slsk:peer:i')

const Messages = require('./messages.js')
const MessageFactory = require('./message-factory.js')
const downloadPeerFile = require('./download-peer-file.js')
let stack = require('./stack')

// TODO make this to store, to be required by other modules
let client
let peers = {}

class SlskClient extends EventEmitter {
  init (cb) {
    debug('Init client')

    client = net.createConnection({
      host: 'server.slsknet.org',
      port: 2242
    }, cb)

    let msgs = new Messages()

    client.on('error', err => {
      cb(new Error(err.message))
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
          } else {
            let reason = msg.str()
            stack.login(new Error(reason))
            delete stack.login
          }
          break
        }
        case 18: {
          debug(`recv ConnectToPeer`)
          this.connectToPeer(msg)
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

    client.on('data', data => {
      msgs.write(data)
    })
  }

  connectToPeer (msg) {
    let user = msg.str()
    let type = msg.str()
    let ip = []
    for (let i = 0; i < 4; i++) {
      ip.push(msg.int8())
    }
    let host = ip[3] + '.' + ip[2] + '.' + ip[1] + '.' + ip[0]
    let port = msg.int32()
    let token = msg.readRawHexStr(4)
    debugPeer(`connectToPeer ${user} ${host} ${port} ${token} ${type}`)

    if (type === 'F') {
      downloadPeerFile(host, port, token, user, false)
      return
    }

    let conn = net.createConnection({
      host,
      port
    }, () => {
      let buf = Buffer.from('05000000' + '00' + token, 'hex')
      conn.write(buf)
      peers[user] = conn
    })

    conn.on('error', error => {
      debug(`${user} error ${error.code}`)
    })

    let msgs = new Messages()

    msgs.on('message', msg => {
      let size = msg.int32()
      debugPeer(`${user} size: ${size}`)
      if (size <= 4) return

      let code = msg.int32()
      switch (code) {
        case 4: {
          debugPeer(`recv GetSharedFileList`)
          let res = MessageFactory
            .to.peer
            .sharedFileList(1, 'test', 1, '@@abcde\\test\\test-test.mp3')
          debugPeer(`sending SharedFileList`)
          conn.write(res.getBuff())
          break
        }
        case 9: {
          debugPeer(`recv FileSearchResult`)
          // This command use zlib for communication, we must decompress it before using it
          let content = msg.data.slice(msg.pointer, size + 4)
          zlib.unzip(content, (err, buffer) => {
            if (err) {
              debugPeer(err)
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
        case 40: {
          let dir = msg.int32()
          let token = msg.rawHexStr(4)
          let file = msg.str()
          debugPeer(`recv TransferRequest ${file}`)
          stack.downloadTokens[token] = {
            user,
            file
          }
          if (dir === 1) {
            stack.downloadTokens[token].size = msg.int32()
          }
          let res = MessageFactory
            .to.peer
            .transferResponse(token)

          setTimeout(() => {
            debugPeer(`sending TransferResponse`)
            conn.write(res.getBuff())
          }, 200)
          break
        }
        case 41: {
          let token = msg.rawHexStr(4)
          let allowed = msg.int8()
          debugPeer(`recv TransferResponse token: ${token} allowed: ${allowed}`)
          if (allowed === 0) {
            let reason = msg.str()
            debugPeer(`reason: ${reason}, I will receive TransferRequest soon...`)
            delete stack.downloadTokens[token] // avoid memory leak
          } else if (allowed === 1) {
            debugPeer(`Directly allowed. Connecting to peer with PeerInit + ${token}`)
            downloadPeerFile(host, port, token, user, true)
          }
          break
        }
        case 46: {
          let filename = msg.str()
          debugPeer(`UploadFailed ${filename}`)
          let down = stack.download[user + '_' + filename]
          if (down && typeof down.cb === 'function') {
            down.cb(new Error('Peer error'))
          } else {
            debugPeer(`Cannot cb for ${user} ${filename}`)
          }
          break
        }
        default: {
          debugPeer(`unknown peer message code ${code}`)
        }
      }
    })

    conn.on('data', data => {
      msgs.write(data)
    })
  }

  login (credentials, cb) {
    stack.currentLogin = credentials.user
    let msg = MessageFactory
      .to.server
      .login(credentials)
    client.write(msg.getBuff())
    stack.login = cb
  }

  search (obj, cb) {
    if (typeof cb !== 'function') {
      throw new Error('2nd argument must be callback function')
    }

    let token = crypto.randomBytes(4).toString('hex')
    let timeout = obj.timeout || 4000
    let results = []
    setTimeout(() => {
      delete stack.search[token]
      cb(null, results)
    }, timeout)
    stack.search[token] = {
      cb: res => {
        this.emit('found', res)
        this.emit(`found:${obj.req}`, res)
        results.push(res)
      },
      query: obj.req
    }

    let msg = MessageFactory
      .to.server
      .fileSearch(obj.req, token)
    client.write(msg.getBuff())
  }

  download (obj, cb, stream) {
    debug(`launch download ${obj.user} ${obj.file}`)
    if (typeof cb !== 'function' && !stream) {
      throw new Error('2nd argument must be callback function')
    }
    if (typeof obj.file === 'undefined') {
      throw new Error('You must specify file')
    }

    if (!peers[obj.file.user]) {
      // console.log(obj)
      // console.log(Object.keys(peers))
      return cb(new Error('User not exist'))
    }
    let token = crypto.randomBytes(4).toString('hex')

    let msg = MessageFactory
      .to.peer
      .transferRequest(obj.file.file, token)

    stack.downloadTokens[token] = {
      user: obj.file.user,
      file: obj.file.file,
      size: obj.file.size
    }

    stack.download[obj.file.user + '_' + obj.file.file] = {
      cb,
      path: obj.path,
      stream
    }
    peers[obj.file.user].write(msg.getBuff())
  }

  downloadStream (obj, cb) {
    let s = new stream.Readable()
    s._read = () => {}
    cb(null, s)
    this.download(obj, null, s)
  }

  destroy () {
    client.destroy()
    delete stack.login
  }
}

module.exports = SlskClient
