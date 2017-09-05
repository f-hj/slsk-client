const net = require('net')
const crypto = require('crypto')
const zlib = require('zlib')
const fs = require('fs')

const hex = require('hex')
const debug = require('debug')('slsk:i')

const Message = require('./message.js')
const Messages = require('./messages.js')

let client
let stack = {
  search: {},
  download: {},
  downloadTokens: {}
}
let peers = {}
let rest
let currentLogin

module.exports = {
  connect: (obj, cb) => {
    initClient(() => {
      let timeout = obj.timeout || 2000
      setTimeout(() => {
        if (stack.login) {
          delete stack.login
          cb(new Error('timeout login'))
        }
      }, timeout)
      login(obj, err => {
        if (err) return cb(err)
        cb(null, new SlskClient())
      })
    })
  },
  disconnect: () => {
    client.destroy()
    delete stack.login
    rest = undefined
  }
}

class SlskClient {
  constructor() {

  }

  search(obj, cb) {
    let msg = new Message()
    let token = crypto.randomBytes(4).toString('hex')
    msg.int32(26) //code
      .rawHexStr(token) //token as int
      .str(obj.req) //req

    let timeout = obj.timeout || 4000
    let results = []
    setTimeout(() => {
      delete stack.search[token]
      cb(null, results)
    }, timeout)
    stack.search[token] = {
      cb: res => {
        results.push(res)
      },
      query: obj.req
    }

    client.write(msg.getBuff())
  }

  download(obj, cb) {
    if (!peers[obj.user]) {
      return cb(new Error('User not exist'))
    }
    let token = crypto.randomBytes(4).toString('hex')
    let msg = new Message()
    msg.int32(40) //code
      .int32(0) //direction
      .rawHexStr(token) //token
      .str(obj.file)

    stack.download[obj.user + '_' + obj.file] = {
      cb,
      query: obj.req
    }
    peers[obj.user].write(msg.getBuff())
  }
}

function initClient(cb) {
  debug('Init client')
  client = net.createConnection({
    host: 'server.slsknet.org',
    port: 2242
  }, cb)
  client.on('data', data => {
    //hex(data)
    let msgs = new Messages(data, rest)
    rest = msgs.rest
    //hex(rest)
    msgs.forEach(msg => {
      let size = msg.int32()
      //debug(`srv size: ${size}`)
      if (size < 4) return
      let code = msg.int32()
      switch (code) {
        case 1: {
          if (!stack.login) return
          let success = msg.int8()
          if (success === 1) {
            //hex(msg.data)
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
          connectToPeer(msg)
          break
        }
        default: {
          debug(`unknown srv message code ${code}`)
        }
      }
    })
  })
}

function connectToPeer(msg) {
  //hex(msg.data)
  let user = msg.str()
  let type = msg.str()
  let ip = []
  for (let i = 0 ; i < 4 ; i++) {
    ip.push(msg.int8())
  }
  let host = ip[3] + '.' + ip[2] + '.' + ip[1] + '.' + ip[0]
  let port = msg.int32()
  let token = msg.readRawHexStr(4)
  //debug(`connectToPeer ${user} ${host} ${port} ${token} ${type}`)

  if (type === 'F') {
    debug(`connectToPeer ${user} ${host} ${port} ${token} ${type}`)
    downloadPeerFile({
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
    //debug(`${user} error ${error.code}`)
  })

  conn.on('data', data => {
    //debug(`${user} data`)
    let msgs = new Messages(data)
    msgs.forEach(msg => {
      let size = msg.int32()
      let code = msg.int32()
      switch (code) {
        case 4: {
          debug(`recv GetSharedFileList`)
          let res = new Message()
          res.int32(5)
            .int32(1) //nb folders
            .str('test')
            .int32(1) //nb files
            .int8(1) //code file
            .str('@@test\\test-test.mp3') //filename
            .int32(3000000) //size1
            .int32(0) //size2
            .str('mp3') //ext
            .int32(0) //nb attributes
          debug(`sending SharedFileList`)
          let resB = res.getBuff()
          hex(resB)
          conn.write(resB)
          break
        }
        case 9: {
          //This command use zlib for communication, we must decompress it before using it
          let content = msg.data.slice(msg.pointer, size + 4)
          zlib.unzip(content, (err, buffer) => {
            if (err) {
              debug(err)
              return
            }
            //hex(buffer)
            msg = new Message(buffer)
            let currentUser = msg.str()
            let currentToken = msg.rawHexStr(4)
            let nbFiles = msg.int32()
            //debug(`${currentUser} nbFiles: ${nbFiles}`)
            let files = []
            for (let i = 0 ; i < nbFiles ; i++) {
              let code = msg.int8()
              let filename = msg.str()
              let filesize = msg.int32()
              let filesize2 = msg.int32()
              let ext = msg.str()
              let nbAttrib = msg.int32()
              msg.seek(nbAttrib * 8)
              //debug(`${filename} ${filesize}`)
              files.push({
                user: currentUser,
                file: filename,
                size: filesize
              })
            }
            let slots = msg.int8()
            let speed = msg.int32()
            if (stack.search[currentToken]) {
              files.forEach(file => {
                stack.search[currentToken].cb({
                  user: file.user,
                  file: file.file,
                  size: file.size,
                  slots,
                  speed
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
          hex(msg.data)
          stack.downloadTokens[token] = {
            user,
            file
          }
          if (dir === 1) {
            stack.downloadTokens[token].size = msg.int32()
          }
          let res = new Message()
          res.int32(41)
            .rawHexStr(token)
            .int8(1)
          let br = res.getBuff()
          setTimeout(() => {
            debug(`sending TransferResponse`)
            hex(br)
            conn.write(br)
          }, 200)
          break
        }
        case 41: {
          let token = msg.rawHexStr(4)
          let allowed = msg.int8()
          debug(`recv TransferResponse token: ${token} allowed: ${allowed}`)
          hex(msg.data)
          if (allowed === 0) {
            let reason = msg.str()
            debug(`reason: ${reason}, I will receive TransferRequest soon...`)
          } else if (allowed === 1) {
            //let size = msg.int32()
            debug(`Directly allowed. Connecting to peer with PeerInit`)
            let down = stack.downloadTokens[token]
            downloadPeerFile({
              host,
              port,
              token,
              user
            }, true)
          }
          break
        }
        default: {
          debug(`unknown peer message code ${code}`)
          hex(msg.data)
        }
      }
    })
  })
}

function login(obj, cb) {
  currentLogin = obj.user
  let msg = new Message()
  msg.int32(1) //code
    .str(obj.user) //user
    .str(obj.pass) //pass
    .int32(157) //version
    .str(crypto.createHash('md5').update(obj.user + obj.pass).digest('hex')) //hash
    .int32(17) //?
    .int32(8) //?
    .int32(2) //?
    .int32(47624) //?
  client.write(msg.getBuff())
  stack.login = cb
}

function downloadPeerFile({host, port, token, user}, noPierce) {
  debug(`downloadPeerFile ${user}`)
  let conn = net.createConnection({
    host,
    port
  }, () => {
    if (noPierce) {
      debug(`noPierce ${user} connected`)
      let m = new Message()
      m.int8(1)
        .str(currentLogin)
        .str('F')
        .int32(0)
      let noPierceB = m.getBuff()
      noPierceB = Buffer.concat([noPierceB, Buffer.from(token, 'hex')])
      hex(noPierceB)
      conn.write(noPierceB)
      setTimeout(() => {
        debug(`noPierce sending 8* 00`)
        conn.write(Buffer.from('00000000' + '00000000', 'hex'))
      }, 200)
      return
    }
    let buf = Buffer.from('05000000' + '00' + token, 'hex')
    conn.write(buf)
  })

  let received = false
  let requestToken
  let buf = new Buffer(0)
  let tok
  if (noPierce) {
    tok = token
  }
  let i = 0
  conn.on('data', data => {
    if (!noPierce && !received) {
      requestToken = data.toString('hex', 0, 4)
      conn.write(Buffer.from('00000000' + '00000000', 'hex'))
      received = true
    } else {
      //debug(`file data`)
      buf = Buffer.concat([buf, data])
    }
    if (tok) {
      if (i % 10 === 0) {
        debug(`buf: ${buf.length} size: ${tok.size}`)
      }
      i++
    } else {
      tok = stack.downloadTokens[requestToken]
    }
    if (tok && buf.length >= tok.size) {
      debug(`disconnect, buf: ${buf.length} size: ${tok.size}`)
      conn.end()
    }
  })
  conn.on('close', () => {
    console.log('CLOSED')
    if (tok) {
      name = getFilePathName(tok.file)
      fs.writeFile(tok.user + '_' + name, buf)
      let down = stack.download[tok.user + '_' + tok.file]
      down.path = tok.user + '_' + name
      down.buffer = buf
      down.cb(null, down)
    } else {
      console.log(stack.downloadTokens)
      fs.writeFile('test.mp3', buf)
      debug(`token ${token} not exist`)
    }
  })
}

function getFilePathName(name) {
  name = name.split('\\')
  return name[name.length -1]
}
