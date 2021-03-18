const stream = require('stream')
const Message = require('./message.js')

class Messages extends stream.Writable {
  _write (chunk, enc, next) {
    this.read(
      this.rest ? Buffer.concat([this.rest, chunk]) : chunk
    )
    next()
  }

  read (data) {
    if (data.length < 4) {
      this.rest = data.slice(0, data.length)
      return
    }

    let size = data.readUInt32LE()
    if (size + 4 <= data.length) {
      this.emit('message', new Message(data.slice(0, size + 4)))
      this.read(data.slice(size + 4, data.length))
    } else {
      this.rest = data.slice(0, data.length)
    }
  }

  reset () {
    this.rest = undefined
  }
}

module.exports = Messages
