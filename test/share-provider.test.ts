import assert from 'assert'
import fs from 'fs'
import { Readable } from 'stream'
import ShareIndex from '../src/share/share-index'
import fsShareProvider, { type FsLike, type FsLikeFileHandle, type FsLikeStats } from '../src/share/providers/fs'
import memoryShareProvider from '../src/share/providers/memory'
import type { ShareEntry, ShareProvider } from '../src/share/provider'

/** Reads a whole stream, what the upload side will do with what a provider returns */
async function readAll (stream: Readable | Promise<Readable>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of await stream) {
    chunks.push(Buffer.from(chunk as Buffer))
  }
  return Buffer.concat(chunks)
}

/**
 * Minimal `fs.promises` compatible implementation over a flat path → content map, without
 * createReadStream, to exercise both the injection point and the chunked reader.
 */
function fakeFs (tree: Record<string, string>): FsLike {
  const isDirectory = (path: string): boolean =>
    Object.keys(tree).some(key => key.startsWith(path.replace(/\/$/, '') + '/'))

  const stats = (path: string): FsLikeStats => {
    const content = tree[path]
    if (content !== undefined) {
      return {
        size: Buffer.byteLength(content),
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false
      }
    }
    if (isDirectory(path)) {
      return { size: 0, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false }
    }
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
  }

  return {
    readdir: async (path: string) => {
      const prefix = path.replace(/\/$/, '') + '/'
      const names = Object.keys(tree)
        .filter(key => key.startsWith(prefix))
        .map(key => key.substring(prefix.length).split('/')[0])
      if (names.length === 0) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return [...new Set(names)]
    },
    stat: async (path: string) => stats(path),
    open: async (path: string): Promise<FsLikeFileHandle> => {
      const data = Buffer.from(tree[path] ?? '')
      if (tree[path] === undefined) throw new Error(`ENOENT: ${path}`)
      return {
        read: async (buffer, offset, length, position) => {
          const copied = data.copy(buffer, offset, position, Math.min(position + length, data.length))
          return { bytesRead: copied }
        },
        close: async () => {}
      }
    }
  }
}

describe('share providers', () => {
  describe('memoryShareProvider', () => {
    const provider = memoryShareProvider([
      { path: 'bucket/song.mp3', data: 'hello world', attribs: { 0: 320, 1: 214 } },
      { path: 'bucket\\live\\encore.flac', data: 'flac data' }
    ])

    it('lists the files with normalized paths', async () => {
      const index = new ShareIndex()
      index.add(provider)
      await index.refresh()

      assert.deepStrictEqual(index.files.map(entry => entry.path), [
        'bucket\\song.mp3',
        'bucket\\live\\encore.flac'
      ])
      assert.strictEqual(index.files[0].size, 11)
    })

    it('reads the bytes of a file', async () => {
      const entry: ShareEntry = { path: 'bucket\\song.mp3', size: 11 }
      assert.strictEqual((await readAll(provider.read(entry, { start: 0 }))).toString(), 'hello world')
    })

    it('reads from an offset, to resume a transfer', async () => {
      const entry: ShareEntry = { path: 'bucket\\song.mp3', size: 11 }
      assert.strictEqual((await readAll(provider.read(entry, { start: 6 }))).toString(), 'world')
    })

    it('keeps the attributes of a file', async () => {
      const index = new ShareIndex()
      index.add(provider)
      await index.refresh()

      assert.deepStrictEqual(index.resolve('bucket\\song.mp3')?.entry.attribs, { 0: 320, 1: 214 })
    })
  })

  describe('fsShareProvider', () => {
    const baseFolder = '/tmp/slsk-share-provider'

    before(async () => {
      await fs.promises.mkdir(baseFolder + '/live', { recursive: true })
      await fs.promises.writeFile(baseFolder + '/song.mp3', 'hello world')
      await fs.promises.writeFile(baseFolder + '/live/encore.flac', 'flac data')
    })

    it('lists a folder as virtual paths keeping the real path as id', async () => {
      const index = new ShareIndex()
      index.add(fsShareProvider({ folders: [baseFolder] }))
      await index.refresh()

      assert.deepStrictEqual(index.files, [
        {
          path: 'slsk-share-provider\\live\\encore.flac',
          size: 9,
          id: baseFolder + '/live/encore.flac'
        },
        {
          path: 'slsk-share-provider\\song.mp3',
          size: 11,
          id: baseFolder + '/song.mp3'
        }
      ] satisfies ShareEntry[])
    })

    it('names the virtual root as asked', async () => {
      const index = new ShareIndex()
      index.add(fsShareProvider({ folders: [baseFolder], root: 'my music' }))
      await index.refresh()

      assert.ok(index.files.every(entry => entry.path.startsWith('my music\\')))
    })

    it('reads a file from an offset', async () => {
      const provider = fsShareProvider({ folders: [baseFolder] })
      const entry: ShareEntry = { path: 'x', size: 11, id: baseFolder + '/song.mp3' }

      assert.strictEqual((await readAll(provider.read(entry, { start: 0 }))).toString(), 'hello world')
      assert.strictEqual((await readAll(provider.read(entry, { start: 6 }))).toString(), 'world')
    })

    it('picks up the files added since the last listing', async () => {
      const index = new ShareIndex()
      index.add(fsShareProvider({ folders: [baseFolder] }))
      await index.refresh()
      const before = index.stats().files

      await fs.promises.writeFile(baseFolder + '/live/added.mp3', 'more')
      await index.refresh()

      assert.strictEqual(index.stats().files, before + 1)
      await fs.promises.unlink(baseFolder + '/live/added.mp3')
    })

    it('works on any fs.promises compatible implementation', async () => {
      const provider = fsShareProvider({
        folders: ['/fake/music'],
        fs: fakeFs({
          '/fake/music/song.mp3': 'hello world',
          '/fake/music/live/encore.flac': 'flac data'
        })
      })

      const index = new ShareIndex()
      index.add(provider)
      await index.refresh()

      assert.deepStrictEqual(index.files.map(entry => entry.path), [
        'music\\live\\encore.flac',
        'music\\song.mp3'
      ])

      // no createReadStream on that implementation: the provider reads the handle by chunks
      const entry = index.resolve('music\\song.mp3')?.entry as ShareEntry
      assert.strictEqual((await readAll(provider.read(entry, { start: 0 }))).toString(), 'hello world')
      assert.strictEqual((await readAll(provider.read(entry, { start: 6 }))).toString(), 'world')
    })

    it('leaves the hidden files out of the share', async () => {
      await fs.promises.writeFile(baseFolder + '/.DS_Store', 'junk')

      const index = new ShareIndex()
      index.add(fsShareProvider({ folders: [baseFolder] }))
      await index.refresh()
      assert.ok(
        index.files.every(entry => !entry.path.includes('.DS_Store')),
        'peers have no use for the hidden files'
      )

      const withHidden = new ShareIndex()
      withHidden.add(fsShareProvider({ folders: [baseFolder], includeHidden: true }))
      await withHidden.refresh()
      assert.ok(withHidden.files.some(entry => entry.path.endsWith('.DS_Store')))
    })

    it('does not fail on a folder that cannot be read', async () => {
      const index = new ShareIndex()
      index.add(fsShareProvider({ folders: ['/tmp/slsk-share-provider-nope'] }))
      await index.refresh()

      assert.deepStrictEqual(index.files, [])
    })
  })

  describe('ShareIndex', () => {
    const provider = memoryShareProvider({ 'bucket/song.mp3': 'hello world' })

    it('only resolves what it advertised', async () => {
      const index = new ShareIndex()
      index.add(provider)
      await index.refresh()

      assert.strictEqual(index.resolve('bucket\\song.mp3')?.entry.size, 11)
      // a peer sends back whatever it wants, nothing outside the share may be reached
      assert.strictEqual(index.resolve('..\\..\\etc\\passwd'), undefined)
      assert.strictEqual(index.resolve('/etc/passwd'), undefined)
      assert.strictEqual(index.resolve('bucket\\..\\..\\etc\\passwd'), undefined)
      assert.strictEqual(index.resolve('bucket\\other.mp3'), undefined)
    })

    it('resolves the path whatever its case and separators', async () => {
      const index = new ShareIndex()
      index.add(provider)
      await index.refresh()

      assert.ok(index.resolve('BUCKET\\Song.MP3'))
      assert.ok(index.resolve('bucket/song.mp3'))
    })

    it('keeps the first provider sharing a path', async () => {
      const index = new ShareIndex()
      index.add(memoryShareProvider({ 'bucket/song.mp3': 'first' }))
      index.add(memoryShareProvider({ 'bucket/song.mp3': 'second' }))
      await index.refresh()

      assert.strictEqual(index.stats().files, 1)
      assert.strictEqual(index.files[0].size, 5)
    })

    it('handles a file bigger than 4 GiB', async () => {
      const size = 6 * 1024 * 1024 * 1024
      const huge: ShareProvider = {
        name: 'huge',
        list: () => [{ path: 'bucket\\dj set.flac', size }],
        read: () => Readable.from([])
      }

      const index = new ShareIndex()
      index.add(huge)
      await index.refresh()

      assert.strictEqual(index.resolve('bucket\\dj set.flac')?.entry.size, size)
    })

    it('lets a provider answer the search itself', async () => {
      const queries: string[] = []
      const searchable: ShareProvider = {
        name: 'searchable',
        list: () => [{ path: 'db\\song.mp3', size: 4 }, { path: 'db\\other.mp3', size: 4 }],
        read: () => Readable.from([]),
        search: query => {
          queries.push(query)
          return [{ path: 'db\\song.mp3', size: 4 }]
        }
      }

      const index = new ShareIndex()
      index.add(searchable)
      await index.refresh()

      const results = await index.search('anything')
      assert.deepStrictEqual(queries, ['anything'])
      assert.deepStrictEqual(results.map(entry => entry.path), ['db\\song.mp3'])
    })

    it('ignores what a provider search returns outside of its shares', async () => {
      const lying: ShareProvider = {
        name: 'lying',
        list: () => [{ path: 'db\\song.mp3', size: 4 }],
        read: () => Readable.from([]),
        search: () => [{ path: '..\\..\\etc\\passwd', size: 4 }]
      }

      const index = new ShareIndex()
      index.add(lying)
      await index.refresh()

      assert.deepStrictEqual(await index.search('passwd'), [])
    })

    it('survives a provider that fails to list', async () => {
      const broken: ShareProvider = {
        name: 'broken',
        list: () => { throw new Error('backend down') },
        read: () => Readable.from([])
      }

      const index = new ShareIndex()
      index.add(broken)
      index.add(provider)
      await index.refresh()

      assert.strictEqual(index.stats().files, 1)
    })

    it('closes every provider', async () => {
      let closed = false
      const index = new ShareIndex()
      index.add({
        list: () => [],
        read: () => Readable.from([]),
        close: () => { closed = true }
      })
      await index.refresh()
      await index.close()

      assert.strictEqual(closed, true)
    })
  })
})
