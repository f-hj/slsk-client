const net = require('net')
const fs = require('fs')
const debug = require('debug')('slsk:peer:file')
const MessageFactory = require('../message-factory.js')

const { tmpDir } = require('../index')
let stack = require('../stack')

module.exports = (host, port, token, user, noPierce) => {
  debug(`downloadPeerFile ${user}`)
  let conn = net.createConnection({
    host,
    port
  }, () => {
    if (noPierce) {
      debug(`noPierce ${user} connected`)
      conn.write(MessageFactory
        .to.peer
        .peerInit(stack.currentLogin, 'F', token)
        .getBuff())

      setTimeout(() => {
        debug(`noPierce sending 8* 00`)
        if (conn.destroyed) {
          debug(`socket closed`)
          return
        }
        conn.write(Buffer.from('00000000' + '00000000', 'hex'))
      }, 1000)
    } else {
      conn.write(MessageFactory
        .to.peer
        .pierceFw(token)
        .getBuff())
    }
  })

  let received = false
  let requestToken = noPierce ? token : undefined
  let buf = Buffer.alloc(0)
  let tok
  let down
  let i = 0

  conn.on('data', data => {
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
        debug(`buf: ${buf.length} size: ${tok.size}`)
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
    debug(`file socket close ${user}`)
    if (tok && down) {
      if (down.stream) down.stream.push(null)
      const filePath = down.path || getFilePathName(tok.user, tok.file)
      fs.writeFile(filePath, buf, () => {
        down.path = filePath
        down.buffer = buf
        if (typeof down.cb === 'function') down.cb(null, down)
      })
    } else {
      fs.writeFile(`${user}-${token}.mp3`, buf, () => {})
      debug(`ERROR: token ${token} not exist`)
    }
  })

  conn.on('error', () => {
    debug(`file socket error ${user}, destroying`)
    conn.destroy()
    // close event will be called (https://nodejs.org/api/net.html#net_event_error_1)
  })
}

function getFilePathName (user, file) {
  file = file.split('\\')
  return `${tmpDir}/${user}_${file[file.length - 1]}`
}
