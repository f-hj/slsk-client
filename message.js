class Message {
  constructor(buffer) {
    if (buffer) {
      this.data = buffer
      this.write = false
    } else {
      this.data = new Buffer(0)
      this.write = true
    }
    this.pointer = 0
  }

  int8 (val) {
    return this.write ? this.write8(val) : this.read8()
  }
  int32 (val) {
    return this.write ? this.write32(val) : this.read32()
  }
  str (val) {
    return this.write ? this.writeStr(val) : this.readStr()
  }

  write8(val) {
    let b new Buffer(1)
    b.writeUInt8(val, 0)
    Buffer.concat([this.data, b])
    this.pointer += 1
    return this
  }
  write32(val) {
    let b new Buffer(4)
    b.writeUInt32LE(val, 0)
    Buffer.concat([this.data, b])
    this.pointer += 4
    return this
  }
  writeStr(val) {
    return this
  }

  read8 () {

  }
  read32 () {

  }
  readStr () {

  }

  getBuff() {
    let b new Buffer(4)
    b.writeUInt32LE(this.data.length, 0)
    Buffer.concat([this.data, b])
    return this.data
  }

}
