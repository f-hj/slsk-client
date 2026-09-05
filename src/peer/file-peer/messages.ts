/**
 * What travels on a file connection (type F) once the init message is out of the way: fixed
 * width frames, without the size prefix and the code of the messages of the other connections.
 * The uploader announces the transfer with its token, the downloader answers with the offset
 * it wants to start at, and the file bytes follow.
 */
const fileMessages = {
  /** The 4 bytes of the transfer token, as the uploader announces it */
  token: (token: string): Buffer => {
    return Buffer.from(token, 'hex')
  },
  /** The first byte the downloader wants, 0 for a fresh transfer */
  offset: (offset: number): Buffer => {
    const buffer = Buffer.alloc(8)
    buffer.writeBigUInt64LE(BigInt(offset), 0)
    return buffer
  },
  /** Reads the token the uploader announced */
  parseToken: (data: Buffer): string => {
    return data.toString('hex', 0, 4)
  },
  /** Reads the offset the downloader asked for */
  parseOffset: (data: Buffer): number => {
    return Number(data.readBigUInt64LE(0))
  }
}

/** Bytes of the token frame, which has to be read before anything else */
export const TOKEN_SIZE = 4
/** Bytes of the offset frame */
export const OFFSET_SIZE = 8

export default fileMessages
