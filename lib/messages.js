const Message = require('./message.js')

class Messages {
  constructor (data) {
    this.messages = []

    let pointer = 0
    while (pointer < data.length) {
      let oPointer = pointer
      let size = data.readUInt32LE(pointer)
      this.messages.push(new Message(data.slice(pointer, pointer + size + 4)))
      pointer = oPointer + size + 4
    }
  }

  forEach (cb) {
    this.messages.forEach(cb)
  }
}

module.exports = Messages
