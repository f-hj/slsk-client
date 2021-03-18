class Message {
  private data: Buffer
  private write: boolean
  private pointer: number = 0

  constructor (buffer: Buffer) {
    if (buffer) {
      this.data = buffer
      this.write = false
    } else {
      this.data = Buffer.alloc(0)
      this.write = true
    }
    this.pointer = 0
  }

  int8 (val?: number) {
    return this.write ? this.write8(val!) : this.read8()
  }
  int32 (val?: number) {
    return this.write ? this.write32(val!) : this.read32()
  }
  str (val?: string) {
    return this.write ? this.writeStr(val!) : this.readStr()
  }

  size () {
    return this.data.length
  }
  seek (val: number) {
    this.pointer += val
  }

  write8 (val: number) {
    let b = Buffer.alloc(1)
    b.writeUInt8(val, 0)
    this.data = Buffer.concat([this.data, b])
    this.pointer += 1
    return this
  }
  write32 (val: number) {
    let b = Buffer.alloc(4)
    b.writeUInt32LE(val, 0)
    this.data = Buffer.concat([this.data, b])
    this.pointer += 4
    return this
  }
  writeStr (val: string) {
    // convert to buff
    let b = Buffer.from(val, 'utf8')
    let s = Buffer.alloc(4)
    s.writeUInt32LE(b.length, 0)
    // write length
    b = Buffer.concat([s, b])
    // write text
    this.data = Buffer.concat([this.data, b])
    return this
  }

  writeRawHexStr (val: string) {
    let b = Buffer.from(val, 'hex')
    this.data = Buffer.concat([this.data, b])
    this.pointer += b.length
    return this
  }

  writeBuffer (buff: Buffer) {
    this.data = Buffer.concat([this.data, buff])
    this.pointer += buff.length
    return this
  }

  read8 () {
    let val = this.data.readUInt8(this.pointer)
    this.pointer += 1
    return val
  }
  read32 () {
    let val = this.data.readUInt32LE(this.pointer)
    this.pointer += 4
    return val
  }
  readStr () {
    let size = this.data.readUInt32LE(this.pointer)
    this.pointer += 4
    let str = this.data.toString('utf8', this.pointer, this.pointer + size)
    this.pointer += size
    return str
  }

  readRawHexStr (size: number) {
    let str = this.data.toString('hex', this.pointer, this.pointer + size)
    this.pointer += size
    return str
  }

  getBuff () {
    let b = Buffer.alloc(4)
    b.writeUInt32LE(this.data.length, 0)
    this.data = Buffer.concat([b, this.data])
    this.write = false
    return this.data
  }
}

export { Message }
