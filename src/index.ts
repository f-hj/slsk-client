import fs from 'fs'
import SlskClient from './slsk-client'
import fsShareProvider from './share/providers/fs'
import memoryShareProvider from './share/providers/memory'
import Shared from './share/shared'
import ShareIndex from './share/share-index'
import type { ConnectOptions, ServerAddress } from './types'

export * from './types'
export * from './share/provider'
export type { FsLike, FsLikeFileHandle, FsLikeStats, FsShareProviderOptions } from './share/providers/fs'
export type { MemoryShareFile } from './share/providers/memory'
export type { IndexedEntry } from './share/share-index'
export { SlskClient, Shared, ShareIndex, fsShareProvider, memoryShareProvider }

let client: SlskClient | undefined

/**
 * Connects and logs into a slsk server, resolving with a ready-to-use client.
 * Rejects when the connection fails, the credentials are refused or the login times out.
 */
export async function connect (obj: ConnectOptions): Promise<SlskClient> {
  await fs.promises.mkdir('/tmp/slsk', { recursive: true })

  const serverAddress: ServerAddress = {
    host: obj.host || 'server.slsknet.org',
    port: obj.port || 2242
  }

  const sharedFolders = obj.sharedFolders || []
  const shares = obj.shares ? (Array.isArray(obj.shares) ? obj.shares : [obj.shares]) : []

  client = new SlskClient(serverAddress, sharedFolders, shares)
  try {
    await client.init()
    await client.login(obj)
  } catch (err) {
    client.destroy()
    client = undefined
    throw err
  }
  return client
}

/** Destroys the last client created with connect() */
export function disconnect (): void {
  if (client) client.destroy()
  client = undefined
}

export default { connect, disconnect }
