const fs = require('fs')
const SlskClient = require('./slsk-client')
let stack = require('./stack')

let client = undefined

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

    this.client = new SlskClient()
    this.client.init(err => {
      if (err) return cb(err)
      let timeout = obj.timeout || 2000
      setTimeout(() => {
        if (stack.login) {
          delete stack.login
          cb(new Error('timeout login'))
        }
      }, timeout)

      this.client.login(obj, err => {
        if (err) return cb(err)
        cb(null, this.client)
      })
    })
  },
  disconnect: () => {
    this.client.destroy()
  }
}
