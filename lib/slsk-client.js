const EventEmitter = require('events')

const net = require('net')
const crypto = require('crypto')
const zlib = require('zlib')
const fs = require('fs')
const stream = require('stream')

// const hex = require('hex')
const hex = () => {}
const debug = require('debug')('slsk:i')
const debugPeer = require('debug')('slsk:peer:i')
const debugPeerFile = require('debug')('slsk:peer:file')
// const debugServer = require('debug')('slsk:srv')

const Messages = require('./messages.js')
const MessageFactory = require('./message-factory.js')
let stack = require('./stack')

// TODO make this to store, to be required by other modules
let client
let peers = {}
let rest
let currentLogin

class SlskClient extends EventEmitter {
  init (cb) {
    debug('Init client')
    client = net.createConnection({
      host: 'server.slsknet.org',
      port: 2242
    }, cb)
    let oldData
    client.on('data', data => {
      debug('data')
      // hex(data)
      if (rest) {
        debug(`rest length: ${rest.length}`)
      }
      let msgs = new Messages(data, rest)
      rest = msgs.rest
      // debug(`srv rest`)
      // if (rest) debug(`rest length: ${rest.length}`)
      // debug(`data length: ${data.length}`)
      // debug(`nb msgs: ${msgs.length}`)
      if (msgs.length === 0) {
        debug('no message usable')
        if (oldData) {
          debug('oldData')
          hex(oldData)
        }
        debug('data')
        hex(data.slice(0, 160))
        debug('rest')
        hex(rest.slice(0, 160))
        // throw new Error('test')
      }
      oldData = data
      msgs.forEach(msg => {
        let size = msg.int32()
        // debug(`srv size: ${size}`)
        if (size < 4) return
        let code = msg.int32()
        switch (code) {
          case 1: {
            debug(`Login Response`)
            if (!stack.login) return
            let success = msg.int8()
            if (success === 1) {
              // hex(msg.data)
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
            // console.log(rooms)
            hex(msg.data.slice(0, 160))
            break
          }
          default: {
            debug(`unknown srv message code: ${code} length: ${msg.data.length}`)
            hex(msg.data.slice(0, 160))
            if (code > 1002) {
              rest = undefined
            }
          }
        }
      })
    })
    client.on('error', err => {
      cb(new Error(err.message))
    })
  }

  connectToPeer (msg) {
    // hex(msg.data)
    let user = msg.str()
    let type = msg.str()
    let ip = []
    for (let i = 0; i < 4; i++) {
      ip.push(msg.int8())
    }
    let host = ip[3] + '.' + ip[2] + '.' + ip[1] + '.' + ip[0]
    let port = msg.int32()
    let token = msg.readRawHexStr(4)
    // debug(`connectToPeer ${user} ${host} ${port} ${token} ${type}`)

    if (type === 'F') {
      // debug(`connectToPeer ${user} ${host} ${port} ${token} ${type}`)
      this.downloadPeerFile({
        user,
        host,
        port,
        token
      })
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

    let peerRest

    conn.on('data', data => {
      // debugPeer(`${user} data`)

      // Sometimes, one TCP packet is too small, with zlib too...
      let msgs = new Messages(data, peerRest)
      peerRest = msgs.rest

      msgs.forEach(msg => {
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
            hex(msg.data)
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
            hex(msg.data)
            if (allowed === 0) {
              let reason = msg.str()
              debugPeer(`reason: ${reason}, I will receive TransferRequest soon...`)
              delete stack.downloadTokens[token] // avoid memory leak
            } else if (allowed === 1) {
              // let size = msg.int32()
              debugPeer(`Directly allowed. Connecting to peer with PeerInit + ${token}`)
              // let down = stack.downloadTokens[token]
              this.downloadPeerFile({
                host,
                port,
                token,
                user
              }, true)
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
            hex(msg.data)
          }
        }
      })
    })
  }

  login (credentials, cb) {
    currentLogin = credentials.user
    let msg = MessageFactory
      .to.server
      .login(credentials)
    client.write(msg.getBuff())
    stack.login = cb
  }

  downloadPeerFile ({host, port, token, user, stream}, noPierce) {
    debugPeerFile(`downloadPeerFile ${user}`)
    let conn = net.createConnection({
      host,
      port
    }, () => {
      if (noPierce) {
        debugPeerFile(`noPierce ${user} connected`)
        let m = MessageFactory.to.peer.peerInit(currentLogin)
        let noPierceB = m.getBuff()
        noPierceB = Buffer.concat([noPierceB, Buffer.from(token, 'hex')])
        hex(noPierceB)
        conn.write(noPierceB)
        setTimeout(() => {
          debugPeerFile(`noPierce sending 8* 00`)
          conn.write(Buffer.from('00000000' + '00000000', 'hex'))
        }, 1000)
        return
      }
      let pierceFw = MessageFactory.to.peer.pierceFw(token)
      conn.write(pierceFw.getBuff())
    })

    let received = false
    let requestToken
    if (noPierce) requestToken = token
    let buf = Buffer.alloc(0)
    let tok
    let down
    let i = 0
    conn.on('data', data => {
      // debugPeerFile(`data: ${data.length}`)
      if (!noPierce && !received) {
        requestToken = data.toString('hex', 0, 4)
        conn.write(Buffer.from('00000000' + '00000000', 'hex'))
        received = true
      } else {
        debug(`file data`)
        if (down && down.stream) {
          debug('push to stream')
          down.stream.push(data)
        }
        buf = Buffer.concat([buf, data])
      }
      if (tok) {
        if (i % 10 === 0) {
          debugPeerFile(`buf: ${buf.length} size: ${tok.size}`)
        }
        i++
      } else {
        tok = stack.downloadTokens[requestToken]
        down = stack.download[tok.user + '_' + tok.file]
      }
      if (tok && buf.length >= tok.size) {
        debug(`disconnect, buf: ${buf.length} size: ${tok.size}`)
        conn.end()
      }
    })
    conn.on('close', () => {
      debugPeerFile(`file socket close ${user}`)
      if (tok && down) {
        if (down.stream) down.stream.push(null)
        const filePath = down.path || this.getFilePathName(tok.user, tok.file)
        fs.writeFile(filePath, buf, () => {
          down.path = filePath
          down.buffer = buf
          if (typeof down.cb === 'function') down.cb(null, down)
        })
      } else {
        fs.writeFile('test.mp3', buf)
        debugPeerFile(`ERROR: token ${token} not exist`)
      }
    })
  }

  getFilePathName (user, file) {
    file = file.split('\\')
    return `/tmp/slsk/${user}_${file[file.length - 1]}`
  }

  search (obj, cb) {
    if (typeof cb !== 'function') {
      throw new Error('2nd argument must be callback function')
    }

    let token = crypto.randomBytes(4).toString('hex')
    let msg = MessageFactory
      .to.server
      .fileSearch(obj.req, token)

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
    let dB = msg.getBuff()
    hex(dB)
    peers[obj.file.user].write(dB)
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
    rest = undefined
  }
}

module.exports = SlskClient
