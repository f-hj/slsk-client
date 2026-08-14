import assert from 'assert'
import path from 'path'
import slsk, { SlskClient, type SearchResult } from '../../src/index'

const hasCredentials = Boolean(process.env.SLSK_USER && process.env.SLSK_PASS)
const describeIntegration = hasCredentials ? describe : describe.skip

describeIntegration('multi download', () => {
  let client: SlskClient
  let files: SearchResult[]

  after(() => {
    if (client) client.destroy()
  })

  it('must login', async () => {
    client = await slsk.connect({
      user: process.env.SLSK_USER as string,
      pass: process.env.SLSK_PASS as string
    })
  }).timeout(10000)

  it('must search correctly', async () => {
    const res = await client.search({
      req: 'polo pan',
      timeout: 4000
    })
    files = res.filter(it => path.extname(it.file) === '.mp3')
      .sort((a, b) => (a.size / a.speed) - (b.size / b.speed))
      .filter(it => it.slots)
      .slice(0, 3)

    assert.strictEqual(files.length, 3, 'Test: no file with free slot')
    files.forEach((file, i) => console.log(`file${i + 1}`, file))
  }).timeout(5000)

  it('must download 3 files simultaneously', async () => {
    const downloads = await Promise.all(files.map(file => client.download({ file })))

    downloads.forEach((down, i) => {
      console.log(`file${i + 1} done`)
      console.log(down)
      assert.ok(down.buffer.length > 0)
    })
  }).timeout(420000)
})
