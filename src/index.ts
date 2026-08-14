import fs from 'fs'
import SlskClient from './slsk-client'
import type { ConnectOptions, ServerAddress } from './types'

export * from './types'
export { SlskClient }

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

  client = new SlskClient(serverAddress, sharedFolders)
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
