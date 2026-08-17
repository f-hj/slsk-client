# Soulseek NodeJS client

<img align="right" src="https://fruitice.fr/logo-slsk.png"/>

[![CI](https://github.com/f-hj/slsk-client/actions/workflows/ci.yml/badge.svg)](https://github.com/f-hj/slsk-client/actions/workflows/ci.yml)
[![GitHub stars](https://img.shields.io/github/stars/f-hj/slsk-client.svg)](https://github.com/f-hj/slsk-client/stargazers)

Written in TypeScript, with a fully promise-based (async/await) API.

## Before starting

You must already have a Soulseek account before using this module.

### Implemented
- File search
- File download
- Sharing: peers can search and browse what you share, from the local file system or from
  anything else through a [share provider](#sharing)

### Not implemented

This stuff is not implemented (yet?), but I wait your __PR__!
- Chat
- Uploads: peers find your files but asking for one is still denied (+ Upnp opened port)

## ⚠ Infos
You must choose file with slots: true, or you'll wait a long time before downloading it.

I advise you to sort files by speed and select the best one (OK, speed is sent by client and can be fake, but the big majority is real).

## Getting started
```ts
import { SlskClient } from 'slsk-client'

const client = new SlskClient()
await client.login('username', 'password')

const res = await client.search({
  req: 'random',
  timeout: 2000
})
// res = [
//   {
//     user: 'poulet',
//     file: '@@poulet-files/random.mp3',
//     size: 6437362,
//     slots: true,
//     bitrate: 320,
//     speed: 1251293
//   }
// ]

const data = await client.download({
  file: res[0],
  path: __dirname + '/random.mp3'
})
// can res.send(data.buffer) if you use express
```

## API
### client
#### new SlskClient(options?)

Everything but the credentials is configured here, once.

```ts
const client = new SlskClient({ sharedFolders: ['/home/me/music'] })
```

##### options
| key | value | default | note |
|-----|-------|---------|------|
|host|choose a different host for Slsk server|server.slsknet.org|
|port|choose a different port|2242|
|incomingPort|Port used for incoming connection|2234|
|sharedFolders|Folders of the local file system to be shared|[]|
|shares|One or more [share providers](#sharing), for files that are not on the local file system|[]|
|timeout|Time in ms before the login attempt fails|2000|

#### login(user, pass): Promise\<void\>

Connects to the slsk server, lists the shares, starts listening for incoming peer connections
and logs in: everything the client needs to be usable, so this is the only call to make.

Rejects when the connection fails, the credentials are refused, or the server did not answer the
login before `timeout` ms. Destroy the client when it rejects.

```ts
const client = new SlskClient()
try {
  await client.login('username', 'password')
} catch (err) {
  client.destroy()
  throw err
}
```

#### search(options): Promise\<SearchResult[]\>
##### options
| key | required | value | default | note |
|-----|----------|-------|---------|------|
|req|true|Sent to slsk server/peers to search file, use space to add keyword|
|timeout||Slsk doesn't sent when search is finished. We ignore request after this time|4000|

##### resolves with a list of files

|key | value | note |
|-----|-------|------|
|user|Peer name of slsk|
|file|Full path of peer file|
|size|Size of file|
|slots|Available slots|true if peer have enough slots to get file immediately|
|bitrate|Bitrate of current file|Can be undefined if not sent by client|
|duration|Duration in seconds|Can be undefined if not sent by client|
|vbr|true when the file is VBR encoded|Can be undefined if not sent by client|
|sampleRate|Sample rate in Hz|Can be undefined if not sent by client|
|bitDepth|Bit depth|Can be undefined if not sent by client|
|attribs|All raw attributes sent by the peer|Keyed by `FileAttribute`|
|speed|Speed of peer|Provided by peer, don't know what is it exactly|
|queueLength|Files queued for upload on the peer side|Useful to pick a peer that will answer quickly|

```json
[
  {
    "user": "jambon",
    "file": "@@jambon-slsk/myfile.m4a",
    "slots": true,
    "speed": 32
  }
]
```

##### events
You can also handle results as they arrive with events
```ts
client.on('found', res => {}) // any search result
client.on(`found:${req}`, res => {}) // or only a specific request
```

#### download(options): Promise\<DownloadResult\>

Resolves with the buffered file once it is completely downloaded. (Stored in RAM)

The peer is asked to queue the file (`QueueUpload`), which is what current Soulseek clients expect.
Peers that only understand the legacy request (`TransferRequest` direction 0) are still supported
with `request: 'transfer'`.

##### options
| key | required | value | default | note |
|-----|----------|-------|---------|------|
|file|true|File sent when searched|
|path||Complete path where file will be stored (if you want read it later)|/tmp/slsk/{{originalName}}|
|offset||Bytes already downloaded, to resume a partial download|0|`path` is appended to instead of overwritten|
|request||`queue` (QueueUpload, 43) or `transfer` (legacy TransferRequest, 40)|queue|

##### resolves with
| key | value |
|-----|-------|
|path|Path where the file has been written|
|buffer|Buffer of the received data, the whole file unless the download was resumed|
|receivedBytes|Bytes on disk, `offset` included|
|size|Size announced by the peer, when known: a smaller `receivedBytes` means a partial file|

##### resuming a download
```ts
const offset = (await fs.promises.stat(path)).size
const down = await client.download({ file, path, offset })
```

#### startDownload(options): Promise\<Download\>

Same options as `download()`, but resolves as soon as the file has been asked for, with the
running download instead of its result. Use it to follow one transfer without listening to the
events of the whole client.

```ts
const download = await client.startDownload({ file, path })

download.on('status', status => console.log(status)) // queued, connected, downloading, complete
download.on('queue', place => console.log(`place ${place} in the queue`))
download.on('progress', ({ progress }) => console.log(`${Math.round((progress ?? 0) * 100)}%`))
download.on('failed', err => console.error(err))

const result = await download.promise // same DownloadResult as download() resolves with
```

| member | value |
|--------|-------|
|`status`|`requested`, `queued`, `connected`, `downloading`, `complete` or `failed`|
|`promise`|resolves with the `DownloadResult`, rejects when the transfer fails|
|`stream`|data as it is received, read it before the transfer starts|
|`user`, `file`, `path`, `offset`, `size`, `receivedBytes`|what the transfer is about and how far it got|

#### downloads
The downloads currently running.

#### downloadStream(options): Readable
WARNING: please report any issue with this function
Returns a readable stream, data is pushed as parts are downloaded, can be used for HTTP 206 (partial content) for example.
The stream is destroyed with an error when the peer reports a failure.

##### options
Same as `download(options)`.

#### connectToUser(user, timeout?): Promise\<Peer\>
Connects to a peer, directly and through the server at the same time, and resolves with whichever
answers first. `download()` calls it when needed, so you rarely have to.

#### shares
The [share index](#sharing) of the client, to inspect or change what is shared at runtime.

#### username
Name this client logs in as, empty until `connect()` sends the login.

#### refreshShares(): Promise\<void\>
Lists every share provider again and tells the server how much is shared, to pick up files
added or removed since the last listing.

#### destroy(): void
Closes the connection to the server, the incoming-peer listener and every peer connection.

#### events
| event | payload | note |
|-------|---------|------|
|`found`|`SearchResult`|any search result|
|`found:{req}`|`SearchResult`|result of a specific request|
|`download-progress`|`{ user, file, receivedBytes, totalBytes?, progress? }`|progress of a running download|
|`download-queue`|`{ user, file, place }`|our place in the upload queue of the peer|
|`server-error`|`Error`|error on the connection to the slsk server|
|`listen-error`|`Error`|error on the incoming peer connections server|
|`peer-error`|`Error, user`|error on a peer connection|

```ts
client.on('download-progress', ({ file, progress }) => {
  console.log(file, Math.round((progress ?? 0) * 100) + '%')
})
```

## Sharing

Peers search and browse your shares over the distributed network. Sharing folders of the local
file system only needs `sharedFolders`:

```ts
const client = new SlskClient({ sharedFolders: ['/home/me/music'] })
await client.login('username', 'password')
```

Files are advertised with a virtual, `\` separated path rooted at the base name of the shared
folder: `/home/me/music/Autechre/Amber/01.mp3` is seen by peers as
`music\Autechre\Amber\01.mp3`. Local paths, bucket names and row ids never leave the process.

### Share providers

Anything able to *list* files and to *read the bytes of one file from an offset* can be shared,
not only the local file system:

```ts
export interface ShareProvider {
  readonly name?: string
  /** Everything this provider shares, an array or an (async) iterable to stream a listing */
  list: () => ShareListing
  /** Opens the bytes of an entry, starting at options.start */
  read: (entry: ShareEntry, options: { start: number }) => Readable | Promise<Readable>
  /** Optional freshness check before a transfer starts */
  stat?: (entry: ShareEntry) => Promise<{ size: number } | undefined>
  /** Optional: answer searches from a database or a search engine instead of the built-in matcher */
  search?: (query: string) => Promise<Iterable<ShareEntry>> | Iterable<ShareEntry>
  /** Optional cleanup, called by client.destroy() */
  close?: () => void | Promise<void>
}

export interface ShareEntry {
  /** Path advertised to peers, '\' separated: 'music\Artist\Album\01.mp3' */
  path: string
  size: number
  /** Opaque handle of the file for the provider, given back to read() and stat() */
  id?: string
  /** Attributes sent along the file, keyed by FileAttribute */
  attribs?: Partial<Record<FileAttribute, number>>
}
```

`list()` may be an async iterable so a paginated backend yields entries page by page instead of
building one big array, and `read(entry, { start })` is what makes resuming a transfer possible.

Two providers ship with the module:

| provider | note |
|----------|------|
|`fsShareProvider({ folders, root?, fs?, followSymlinks?, maxDepth? })`|Folders of a file system. `root` renames the virtual root, `fs` accepts any `fs.promises` compatible implementation (memfs, unionfs, a `node:vfs` `promises` namespace...)|
|`memoryShareProvider(files)`|Files held in memory, from a list or a path → content map|

```ts
import { SlskClient, fsShareProvider, memoryShareProvider, type ShareProvider } from 'slsk-client'

const client = new SlskClient({
  shares: [
    fsShareProvider({ folders: ['/home/me/music'], root: 'my music' }),
    memoryShareProvider({ 'jingles\\hello.mp3': jingleBuffer })
  ]
})
await client.login('username', 'password')

client.shares.stats() // { folders: 12, files: 843 }
await client.refreshShares() // after adding files on disk
```

An object storage provider is about ten lines, and only needs the SDK you already use:

```ts
const s3Share = (bucket: string, prefix: string): ShareProvider => ({
  name: 's3',
  list: async function * () {
    for await (const page of paginateListObjectsV2({ client: s3 }, { Bucket: bucket, Prefix: prefix })) {
      for (const object of page.Contents ?? []) {
        if (!object.Key || object.Key.endsWith('/')) continue
        yield { path: object.Key.replaceAll('/', '\\'), size: object.Size ?? 0, id: object.Key }
      }
    }
  },
  read: async (entry, { start }) => {
    const res = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: entry.id,
      Range: `bytes=${start}-`
    }))
    return res.Body as Readable
  }
})
```

A peer can only ever reach a path the index advertised: what it sends back is looked up in the
index, never mapped onto a backend path, so a crafted file name cannot escape the share.

### Answering searches

Search requests received from the distributed network are matched against the whole virtual path
of every shared file, with the same `-` exclusion rules as `search()`. A provider that implements
`search()` answers for its own files instead.

Peers that then ask for one of the files are denied for now: serving the bytes (upload slots,
queue and file connections) is the next step, and the `read()` side of the interface is what it
will use.

## Breaking changes since 2.x

| change | why |
|--------|-----|
|`Download` (the result of `download()`) is now `DownloadResult`|`Download` is the class of a running transfer, returned by `startDownload()`|
|`DownloadResult.stream` is gone|`downloadStream()` returns the stream, and a running `Download` exposes one|
|Shared files are described by `ShareEntry` (`{ path, size, id?, attribs? }`) instead of `SharedFileEntry` (`{ key, value }`)|share providers can come from anywhere, not only from a file system|
|Shared files are advertised with a virtual path (`music\\song.mp3`) instead of the local one (`/home/me/music/song.mp3`)|local paths, bucket names and row ids stay private|
|`Shared.search()` returns a promise|a provider may answer searches from a database or a search engine|
|`slsk.connect()` and `slsk.disconnect()` are gone, and so is the default export|`new SlskClient(options)` + `login(user, pass)` does the same without a module-level client to keep track of|
|`new SlskClient(options)` takes a single options object, and `client.init()` is gone|`login(user, pass)` does all the connecting, so there is only one call to make|
|The internal `stack` module is gone|state belongs to a client, so several clients can share a process|

## Development

```sh
npm install
npm test              # type check + unit tests
npm run build         # compile TypeScript to dist/
npm run coverage      # unit tests with coverage
npm run test:integration  # integration tests against the real slsk network
```

Use env variables for the integration tests (they are skipped when unset)
- `DEBUG=slsk:*` to display debug messages
- `SLSK_USER=MyUsername`
- `SLSK_PASS=MyPassword`

## Protocol compliance

See [docs/PROTOCOL-COMPLIANCE.md](docs/PROTOCOL-COMPLIANCE.md) for a message-by-message report of what this client implements and where it deviates from the documented protocol.

## Soulseek Protocol Documentation

ftp://ftp.tu-clausthal.de/pub/mirror/ftp.gwdg.de/gnu/ftp/savannah/files/mldonkey/docs/Soulseek/soulseek_protocol.html

https://nicotine-plus.org/doc/SLSKPROTOCOL.html

https://github.com/nicotine-plus/nicotine-plus
