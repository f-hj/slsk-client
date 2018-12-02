const EventEmitter = require('events')
const crypto = require('crypto')
const stream = require('stream')
const net = require('net')

const debug = require('debug')('slsk:i')

const Server = require('./server.js')
const DefaultPeer = require('./peer/default-peer.js')
const DistributedPeer = require('./peer/distributed-peer.js')
const downloadPeerFile = require('./peer/download-peer-file.js')
const Listen = require('./listen.js')
const Shared = require('./share/shared.js')
let stack = require('./stack')

let server
let listen
let peers = {}
let shared

class SlskClient extends EventEmitter {
  constructor (serverAddress, sharedFolders) {
    super()
    this.serverAddress = serverAddress
    this.sharedFolders = sharedFolders
  }

  init (cb) {
    debug('Init client')
    server = new Server(this.serverAddress, cb)

    server.on('connect-to-peer', peer => {
      this.connectToPeer(peer)
    })

    server.on('get-peer-address', peer => {
      if (peers[peer.user]) {
        peers[peer.user].setAddress(peer.host, peer.port)
      } else {
        peers[peer.user] = new DefaultPeer(net.createConnection({
          host: peer.host,
          port: peer.port
        }), peer)
        if (stack.peerSearchMatches[peer.user]) {
          Object.keys(stack.peerSearchMatches[peer.user]).forEach(ticket => {
            peers[peer.user].fileSearchResult(stack.peerSearchMatches[peer.user][ticket], ticket, stack.currentLogin)
          })
          stack.peerSearchMatches[peer.user] = {}
        }
      }
    })

    shared = new Shared()
    this.sharedFolders.forEach(folder => shared.scanFolder(folder))
  }

  connectToPeer (peer) {
    debug(`connectToPeer ${peer.user} ${peer.host} ${peer.port} ${peer.token} ${peer.type}`)

    switch (peer.type) {
      case 'F': {
        downloadPeerFile(peer.host, peer.port, peer.token, peer.user, false)
        break
      }
      case 'D': {
        peers[peer.user] = new DistributedPeer(net.createConnection({
          host: peer.host,
          port: peer.port
        }), peer)
        peers[peer.user].on('search', search => {
          let matched = shared.search(search.query)
          if (matched.length > 0) {
            if (!peers[search.user]) {
              server.getPeerAddress(search.user)
              if (!stack.peerSearchMatches[search.user]) {
                stack.peerSearchMatches[search.user] = {
                  [search.ticket]: matched
                }
              } else {
                stack.peerSearchMatches[search.user][search.ticket] = matched
              }
            } else {
              peers[search.user].fileSearchResult(matched, search.ticket, stack.currentLogin)
            }
            debug(`Search from peer ${search.user}, query: ${search.query}. Matched: ${matched.length} files`)
          }
        })
        peers[peer.user].on('disconnect', () => {
          delete peers[peer.user]
        })
        break
      }
      default: {
        peers[peer.user] = new DefaultPeer(net.createConnection({
          host: peer.host,
          port: peer.port
        }), peer)
        peers[peer.user].on('disconnect', () => {
          delete peers[peer.user]
        })
      }
    }
  }

  login (credentials, cb) {
    stack.currentLogin = credentials.user
    server.login(credentials)
    let incomingPort = credentials.incomingPort || 2234
    listen = new Listen(incomingPort)
    listen.on('new-peer', evt => {
      let peer = evt.peer
      if (peers[peer.user]) {
        debug(`Already connected to ${peer.user}`)
      } else {
        server.getPeerAddress(peer.user)
        debug(`new Peer connected ${peer.user} token ${peer.token}`)
        peers[peer.user] = new DefaultPeer(evt.socket, peer)
        peers[peer.user].on('disconnect', () => {
          delete peers[peer.user]
        })
      }
    })
    server.setWaitPort(incomingPort)
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
    if (server) server.destroy()
    if (listen) listen.destroy()

    Object.keys(peers).forEach(peer => {
      peers[peer].destroy()
    })
    delete stack.login
  }
}

module.exports = SlskClient
