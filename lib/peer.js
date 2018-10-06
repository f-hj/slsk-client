const EventEmitter = require('events')
const net = require('net')
const zlib = require('zlib')
const Messages = require('./messages.js')
const MessageFactory = require('./message-factory.js')
const downloadPeerFile = require('./download-peer-file.js')
const debug = require('debug')('slsk:peer:i')

let stack = require('./stack')

module.exports = class Peer extends EventEmitter {
  constructor (peer) {
    super()
    this.conn = net.createConnection({
      host: peer.host,
      port: peer.port
    }, () => {
      let buf = Buffer.from('05000000' + '00' + peer.token, 'hex')
      this.conn.write(buf)
      this.emit('connected', peer)
    })

    this.conn.on('error', error => {
      debug(`${peer.user} error ${error.code}`)
    })

    this.conn.on('end', data => {
      debug(`${peer.user} connection ended ${data}`)
    })

    let msgs = new Messages()

    this.conn.on('data', data => {
      msgs.write(data)
    })

    msgs.on('message', msg => {
      let size = msg.int32()
      debug(`${peer.user} size: ${size}`)
      if (size <= 4) return

      let code = msg.int32()
      switch (code) {
        case 4: {
          debug(`recv GetSharedFileList`)
          let res = MessageFactory
            .to.peer
            .sharedFileList(1, 'test', 1, '@@abcde\\test\\test-test.mp3')
          debug(`sending SharedFileList`)
          this.conn.write(res.getBuff())
          break
        }
        case 9: {
          debug(`recv FileSearchResult`)
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
        case 40: {
          let dir = msg.int32()
          let token = msg.rawHexStr(4)
          let file = msg.str()
          debug(`recv TransferRequest ${file}`)
          stack.downloadTokens[token] = {
            user: peer.user,
            file
          }
          if (dir === 1) {
            stack.downloadTokens[token].size = msg.int32()
          }
          let res = MessageFactory
            .to.peer
            .transferResponse(token)

          setTimeout(() => {
            debug(`sending TransferResponse`)
            this.conn.write(res.getBuff())
          }, 200)
          break
        }
        case 41: {
          let token = msg.rawHexStr(4)
          let allowed = msg.int8()
          debug(`recv TransferResponse token: ${token} allowed: ${allowed}`)
          if (allowed === 0) {
            let reason = msg.str()
            debug(`reason: ${reason}, I will receive TransferRequest soon...`)
            delete stack.downloadTokens[token] // avoid memory leak
          } else if (allowed === 1) {
            debug(`Directly allowed. Connecting to peer with PeerInit + ${token}`)
            downloadPeerFile(peer.host, peer.port, peer.token, peer.user, true)
          }
          break
        }
        case 46: {
          let filename = msg.str()
          debug(`UploadFailed ${filename}`)
          let down = stack.download[peer.user + '_' + filename]
          if (down && typeof down.cb === 'function') {
            down.cb(new Error('Peer error'))
          } else {
            debug(`Cannot cb for ${peer.user} ${filename}`)
          }
          break
        }
        case 50: {
          let filename = msg.str()
          let reason = msg.str()
          debug(`QueueFailed ${filename} reason ${reason}`)
          break
        }
        default: {
          debug(`unknown peer message code ${code}`)
        }
      }
    })
  }

  transferRequest (file, token) {
    debug(`Transfer request ${file}`)
    this.conn.write(MessageFactory
      .to.peer
      .transferRequest(file, token)
      .getBuff())
  }

  destroy () {
    this.conn.destroy()
  }
}
