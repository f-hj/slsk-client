const fs = require('fs')
const SlskClient = require('./slsk-client')
let stack = require('./stack')

let client

const mkdirSync = function (dirPath) {
  try {
    fs.mkdirSync(dirPath)
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }
}

module.exports = {
  connect: (obj, cb) => {
    if (typeof cb !== 'function') {
      throw new Error('2nd argument must be callback function')
    }
    mkdirSync('/tmp/slsk')

    let serverAddress = obj.server || {
      host: 'server.slsknet.org',
      port: 2242
    }

    client = new SlskClient(serverAddress)
    client.init(err => {
      if (err) return cb(err)
      let timeout = obj.timeout || 2000
      setTimeout(() => {
        if (stack.login) {
          delete stack.login
          cb(new Error('timeout login'))
        }
      }, timeout)

      client.login(obj, err => {
        if (err) return cb(err)
        cb(null, client)
      })
    })
  },
  disconnect: () => {
    client.destroy()
  }
}
