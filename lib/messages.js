const hex = require('hex')

const Message = require('./message.js')

class Messages {

  // Implement rest system, because server send multiple messages in one TCP
  // packet, or when one TCP packet is too small.

  constructor (data, rest) {
    this.messages = []
    this.length = 0

    if (rest) {
      data = Buffer.concat([rest, data])
    }

    let pointer = 0
    while (pointer < data.length) {
      let oPointer = pointer
      if (pointer + 4 > data.length) {
        this.rest = data.slice(pointer, data.length)
        pointer += 4
        break
      }
      let size = data.readUInt32LE(pointer)
      if (size + pointer + 4 > data.length) {
        this.rest = data.slice(pointer, data.length)
        pointer += size
        break
      }
      this.messages.push(new Message(data.slice(pointer, pointer + size + 4)))
      pointer = oPointer + size + 4
    }

    this.length = this.messages.length
  }

  get (index) {
    return this.messages[index]
  }

  forEach (cb) {
    this.messages.forEach(cb)
  }
}

module.exports = Messages
