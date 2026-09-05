export default class Message {
  data: Buffer
  pointer = 0
  writable: boolean

  constructor (buffer?: Buffer) {
    if (buffer) {
      this.data = buffer
      this.writable = false
    } else {
      this.data = Buffer.alloc(0)
      this.writable = true
    }
  }

  int8 (): number
  int8 (val: number): this
  int8 (val?: number): number | this {
    return this.writable ? this.write8(val as number) : this.read8()
  }

  int32 (): number
  int32 (val: number): this
  int32 (val?: number): number | this {
    return this.writable ? this.write32(val as number) : this.read32()
  }

  /**
   * 64 bit unsigned little endian integer, used by the protocol for file sizes and offsets.
   * Reading returns a `number`: slsk sizes never come close to 2^53, so the conversion is lossless
   * in practice. Use {@link read64Big} when an exact bigint is needed.
   */
  int64 (): number
  int64 (val: number | bigint): this
  int64 (val?: number | bigint): number | this {
    return this.writable ? this.write64(val as number | bigint) : this.read64()
  }

  str (): string
  str (val: string): this
  str (val?: string): string | this {
    return this.writable ? this.writeStr(val as string) : this.readStr()
  }

  rawHexStr (size: number): string
  rawHexStr (val: string): this
  rawHexStr (val?: string | number): string | this {
    return this.writable
      ? this.writeRawHexStr(val as string)
      : this.readRawHexStr(val as number)
  }

  size (): number {
    return this.data.length
  }

  /** Number of bytes left to read after the current pointer */
  remaining (): number {
    return Math.max(this.data.length - this.pointer, 0)
  }

  seek (val: number): void {
    this.pointer += val
  }

  write8 (val: number): this {
    const b = Buffer.alloc(1)
    b.writeUInt8(val, 0)
    this.data = Buffer.concat([this.data, b])
    this.pointer += 1
    return this
  }

  write32 (val: number): this {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(val, 0)
    this.data = Buffer.concat([this.data, b])
    this.pointer += 4
    return this
  }

  write64 (val: number | bigint): this {
    const b = Buffer.alloc(8)
    b.writeBigUInt64LE(BigInt(val), 0)
    this.data = Buffer.concat([this.data, b])
    this.pointer += 8
    return this
  }

  writeStr (val: string): this {
    // convert to buff
    let b = Buffer.from(val, 'utf8')
    const s = Buffer.alloc(4)
    s.writeUInt32LE(b.length, 0)
    // write length
    b = Buffer.concat([s, b])
    // write text
    this.data = Buffer.concat([this.data, b])
    return this
  }

  writeRawHexStr (val: string): this {
    const b = Buffer.from(val, 'hex')
    this.data = Buffer.concat([this.data, b])
    this.pointer += b.length
    return this
  }

  writeBuffer (buff: Buffer): this {
    this.data = Buffer.concat([this.data, buff])
    this.pointer += buff.length
    return this
  }

  read8 (): number {
    const val = this.data.readUInt8(this.pointer)
    this.pointer += 1
    return val
  }

  read32 (): number {
    const val = this.data.readUInt32LE(this.pointer)
    this.pointer += 4
    return val
  }

  read64 (): number {
    return Number(this.read64Big())
  }

  read64Big (): bigint {
    const val = this.data.readBigUInt64LE(this.pointer)
    this.pointer += 8
    return val
  }

  readStr (): string {
    const size = this.data.readUInt32LE(this.pointer)
    this.pointer += 4
    const str = this.data.toString('utf8', this.pointer, this.pointer + size)
    this.pointer += size
    return str
  }

  /** Reads `size` raw bytes, for the fields the protocol sends as a length followed by bytes */
  readBuffer (size: number): Buffer {
    const buff = this.data.subarray(this.pointer, this.pointer + size)
    this.pointer += buff.length
    return buff
  }

  readRawHexStr (size: number): string {
    const str = this.data.toString('hex', this.pointer, this.pointer + size)
    this.pointer += size
    return str
  }

  getBuff (): Buffer {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(this.data.length, 0)
    this.data = Buffer.concat([b, this.data])
    this.writable = false
    return this.data
  }
}
