import createDebug from 'debug'
import fileMessages, { TOKEN_SIZE } from './messages'
import type FilePeer from './file-peer'

const debug = createDebug('slsk:peer:file:recv')

/**
 * Handles the download side of a file connection (type F). There is no framing to lean on: the
 * transfer token comes first when the uploader announces it, everything after that is the file,
 * so the state of the transfer lives in this closure.
 */
export default function createFileTransferHandler (peer: FilePeer): (data: Buffer) => void {
  let tokenRead = !peer.readsToken
  let pending = Buffer.alloc(0)
  let dataEvents = 0

  const onFileData = (data: Buffer): void => {
    if (data.length === 0) return

    const download = peer.resolveDownload()
    if (!download) {
      // nothing is waiting for these bytes, better hang up than keep them
      debug(`${peer.label} no download for token ${peer.token ?? 'unknown'}, closing`)
      peer.destroy()
      return
    }

    const complete = download.push(data)
    if (dataEvents++ % 10 === 0) {
      debug(`${peer.label} received ${download.receivedBytes}/${download.size ?? 'unknown'} bytes of ${download.file}`)
    }

    if (complete) {
      debug(`${peer.label} received ${download.receivedBytes}/${download.size ?? 0} bytes of ${download.file}, done`)
      peer.end()
    }
  }

  return function onData (data: Buffer): void {
    if (!tokenRead) {
      if (data.length < TOKEN_SIZE) {
        // extremely unlikely, but the token can be split over two chunks
        pending = Buffer.concat([pending, data])
        if (pending.length < TOKEN_SIZE) return
        data = pending
        pending = Buffer.alloc(0)
      }

      peer.token = fileMessages.parseToken(data)
      tokenRead = true
      debug(`${peer.label} recv FileTransferInit, token ${peer.token}`)
      peer.resolveDownload()
      peer.sendOffset()
      onFileData(data.subarray(TOKEN_SIZE))
      return
    }

    onFileData(data)
  }
}
