const Message = require('./message.js')

class Messages {
  constructor (data, rest) {
    this.messages = []

    if (rest) {
      data = Buffer.concat([rest, data])
    }

    let pointer = 0
    while (pointer < data.length) {
      let oPointer = pointer
      if (pointer + 4 > data.length) {
        this.rest = data.slice(pointer, data.length)
        break
      }
      let size = data.readUInt32LE(pointer)
      if (size + oPointer > data.length) {
        this.rest = data.slice(pointer, data.length)
        break
      }
      this.messages.push(new Message(data.slice(pointer, pointer + size + 4)))
      pointer = oPointer + size + 4
    }
  }

  forEach (cb) {
    this.messages.forEach(cb)
  }
}

module.exports = Messages
