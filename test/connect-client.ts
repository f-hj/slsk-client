import { SlskClient, type SlskClientOptions } from '../src/index'

export interface ConnectClientOptions extends SlskClientOptions {
  user: string
  pass: string
}

/**
 * Builds a client and logs it in, destroying it when the login fails so a failed attempt
 * leaves no socket behind. Only used by the tests, the module exposes the client itself.
 */
export default async function connectClient (options: ConnectClientOptions): Promise<SlskClient> {
  const client = new SlskClient(options)
  try {
    await client.login(options.user, options.pass)
  } catch (err) {
    client.destroy()
    throw err
  }
  return client
}
