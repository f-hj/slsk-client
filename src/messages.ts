import { Writable } from 'stream'
import Message from './message'

/**
 * Re-assembles the TCP byte stream into slsk protocol messages.
 * Emits a 'message' event with a readable Message for each complete frame.
 */
export default class Messages extends Writable {
  private rest?: Buffer

  override _write (chunk: Buffer, _enc: BufferEncoding, next: (error?: Error | null) => void): void {
    this.consume(
      this.rest ? Buffer.concat([this.rest, chunk]) : chunk
    )
    next()
  }

  override on (event: 'message', listener: (msg: Message) => void): this
  override on (event: string | symbol, listener: (...args: any[]) => void): this
  override on (event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener)
  }

  override once (event: 'message', listener: (msg: Message) => void): this
  override once (event: string | symbol, listener: (...args: any[]) => void): this
  override once (event: string | symbol, listener: (...args: any[]) => void): this {
    return super.once(event, listener)
  }

  override emit (event: 'message', msg: Message): boolean
  override emit (event: string | symbol, ...args: any[]): boolean
  override emit (event: string | symbol, ...args: any[]): boolean {
    return super.emit(event, ...args)
  }

  private consume (data: Buffer): void {
    if (data.length < 4) {
      this.rest = data.subarray(0, data.length)
      return
    }

    const size = data.readUInt32LE()
    if (size + 4 <= data.length) {
      this.rest = undefined
      this.emit('message', new Message(data.subarray(0, size + 4)))
      this.consume(data.subarray(size + 4, data.length))
    } else {
      this.rest = data.subarray(0, data.length)
    }
  }

  reset (): void {
    this.rest = undefined
  }
}
