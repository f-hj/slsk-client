import { Message } from './message'

class Messages {
  private rest = Buffer.alloc(0)

  constructor () {}

  read (data: Buffer, cb: (message: Message) => void) {
    if (data.length < 4) {
      this.rest = data.slice(0, data.length)
      return
    }

    const completeData = Buffer.concat([this.rest, data])

    let size = completeData.readUInt32LE()
    if (size + 4 <= completeData.length) {
      cb(new Message(completeData.slice(0, size + 4)))
      this.read(completeData.slice(size + 4, completeData.length), cb)
    } else {
      this.rest = completeData.slice(0, completeData.length)
    }
  }

  reset () {
    this.rest = Buffer.alloc(0)
  }
}

export { Messages }
