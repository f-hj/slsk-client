const EventEmitter = require('events')
const fs = require('fs')
const separator = require('path').sep
const debug = require('debug')('slsk:shared:i')
const matches = require('./matches.js')

module.exports = class Shared extends EventEmitter {
  constructor () {
    super()
    this.files = []

    this.on('file', path => {
      this.files.push({
        key: path.slice(Math.max(path.length - 2, 1)).join(separator),
        value: path.join(separator)
      })
    })
  }

  scanFolder (folder) {
    fs.readdir(folder, (err, files) => {
      if (err) {
        debug(`Folder ${folder} does not exist`)
      } else {
        files.forEach(file => {
          this.scan([folder, file])
        })
        debug(`Scan folder ${folder} completed, ${this.files.length} shared`)
        this.emit('complete', folder)
      }
    })
  }

  scan (path) {
    let file = path.join(separator)

    if (fs.statSync(file).isFile()) {
      this.emit('file', path)
    } else {
      fs.readdirSync(file).forEach(it => {
        this.scan(path.concat([it]))
      })
    }
  }

  search (query) {
    return this.files.filter(it => matches(it.key, query))
  }
}
