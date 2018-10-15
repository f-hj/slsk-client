const EventEmitter = require('events')
const crypto = require('crypto')
const stream = require('stream')

const debug = require('debug')('slsk:i')
const debugPeer = require('debug')('slsk:peer:i')

const downloadPeerFile = require('./download-peer-file.js')
const Server = require('./server.js')
const Peer = require('./peer.js')
const Listen = require('./listen.js')
let stack = require('./stack')

let server
let peers = {}

class SlskClient extends EventEmitter {
  init (cb) {
    debug('Init client')
    server = new Server(cb)

    server.on('connectToPeer', peer => {
      this.connectToPeer(peer)
    })
  }

  connectToPeer (peer) {
    debugPeer(`connectToPeer ${peer.user} ${peer.host} ${peer.port} ${peer.token} ${peer.type}`)

    if (peer.type === 'F') {
      downloadPeerFile(peer.host, peer.port, peer.token, peer.user, false)
      return
    }

    let peerObj = new Peer(peer)
    peerObj.on('connected', () => {
      peers[peer.user] = peerObj
    })
  }

  login (credentials, cb) {
    stack.currentLogin = credentials.user
    server.login(credentials)
    let waitPort = 2234
    let listen = new Listen()
    listen.start(waitPort)
    server.setWaitPort(waitPort)
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

    server.fileSearch(obj.req, token)
  }

  download (obj, cb, stream) {
    debug(`launch download ${obj.file.user} ${obj.file.file}`)
    if (typeof cb !== 'function' && !stream) {
      throw new Error('2nd argument must be callback function')
    }
    if (typeof obj.file === 'undefined') {
      throw new Error('You must specify file')
    }
    if (!peers[obj.file.user]) {
      return cb(new Error('User not exist'))
    }

    let token = crypto.randomBytes(4).toString('hex')

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
    peers[obj.file.user].transferRequest(obj.file.file, token)
  }

  downloadStream (obj, cb) {
    let s = new stream.Readable()
    s._read = () => {}
    cb(null, s)
    this.download(obj, null, s)
  }

  destroy () {
    server.destroy()
    delete stack.login
  }
}

module.exports = SlskClient
