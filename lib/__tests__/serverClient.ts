import { ServerClient } from "../serverClient"

describe('serverClient', () => {
  const sc = new ServerClient({
    host: 'server.slsknet.org',
    port: 2242
  })

  sc.login({
    user: '1',
    pass: '2'
  })
})