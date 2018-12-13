const EventEmitter = require('events')
const fs = require('fs')
const separator = require('path').sep
const debug = require('debug')('slsk:shared:i')
const matches = require('./matches.js')

module.exports = class Shared extends EventEmitter {
  constructor () {
    super()
    this.files = []

    this.on('file', file => {
      let path = file.path
      this.files.push({
        key: path.slice(Math.max(path.length - 2, 1)).join(separator),
        value: {
          file: path.join(separator),
          size: file.size
        }
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
    let stats = fs.statSync(file)
    if (stats.isFile()) {
      this.emit('file', {
        path,
        size: stats.size
      })
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
