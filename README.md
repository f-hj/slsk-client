# Soulseek NodeJS client

![slsk-client logo](https://fruitice.fr/logo-slsk.png)

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
- Uploads: the shared files are sent to the peers that ask for them, with slots and a queue.
  Off by default, see the [`uploads` option](#serving-the-files)

### Not implemented

This stuff is not implemented (yet?), but I wait your __PR__!
- Chat
- Opening the incoming port by UPnP: it has to be reachable for a firewalled peer to be served
- Upload priority for privileged users, per-peer rate limits and a ban list

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
//     speed: 1251293,
//     attribs: { 0: 320, 1: 201 } // FileAttribute.Bitrate, FileAttribute.Duration
//   }
// ]

const data = await client.download({
  ...res[0],
  path: __dirname + '/random.mp3'
})
// can res.send(data.buffer) if you use express
```

## API
### client
#### new SlskClient(options?)

Everything but the credentials is configured here, once.

```ts
const client = new SlskClient({ shares: fsShareProvider({ folders: ['/home/me/music'] }) })
```

##### options
| key | value | default | note |
|-----|-------|---------|------|
|host|choose a different host for Slsk server|server.slsknet.org|
|port|choose a different port|2242|
|incomingPort|Port used for incoming connection|2234|
|shares|One or more [share providers](#sharing): folders of the local file system, files in memory, or anything else|[]|
|uploads|`true`, or `{ slots?, queueLimit? }`, to send the shared files to the peers that ask for them|false|off by default: a client shares a file list and refuses every transfer until you turn it on|
|timeout|Time in ms before the login attempt fails|2000|
|downloadRetries|How many times a transfer that stopped early is asked for again|3|`0` to fail an interrupted download right away|
|transferTimeout|Time in ms of silence on a file connection before it is dropped|600000|A file connection carries the transfer or nothing, so an idle one is dead: a download is then asked for again, an upload loses its slot|
|userInfo|What is answered to a peer asking for our info: `description`, `picture`, `uploadSlots`, `queueSize`, `slotsFree`, `uploadPermitted`|no description, and the slots, queue and permission of the `uploads` option as they stand|Only the keys you set are overridden, so a peer is told the truth about the slots unless you say otherwise|
|reconnect|`false`, or `{ retries?, delay?, maxDelay? }`, to log in again when the server connection drops|`{ retries: Infinity, delay: 1000, maxDelay: 60000 }`|the delay doubles after every failed attempt, up to `maxDelay`|
|downloadTimeout|ms without any progress after which a download fails|none|a queued file can legitimately wait for hours, so there is no timeout unless you set one|
|queueFallbackDelay|ms to wait for a sign that a peer understands `QueueUpload` before asking it the old way|10000|rarely worth changing, it only delays downloads from peers old enough to ignore the queue messages|

#### login(user, pass): Promise\<void\>

Connects to the slsk server, starts listening for incoming peer connections and logs in:
everything the client needs to be usable, so this is the only call to make.

Rejects when the connection fails, the credentials are refused (with a `LoginRefusedError`) or the
server did not answer the login before `timeout` ms. Destroy the client when it rejects.

Calling it again after the connection dropped logs in on a new one, which is what
`reconnect: false` leaves to you.

Listing the shares is __not__ waited for: it starts once the login is through and runs in the
background, because a few thousand files on a slow volume take minutes and the slsk server drops
a connection that stays unauthenticated that long. Await `sharesReady` when you need to know that
peers can find your files.

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
|attribs|Everything the peer said about the file, keyed by `FileAttribute`|Empty when it said nothing, and codes this version knows nothing about are kept as they came|
|speed|Speed of peer|Provided by peer, don't know what is it exactly|
|queueLength|Files queued for upload on the peer side|Useful to pick a peer that will answer quickly|

```ts
import { FileAttribute } from 'slsk-client'

res
  .filter(it => it.attribs[FileAttribute.Bitrate] === 320)
  .filter(it => it.attribs[FileAttribute.VBR] !== 1)
  .sort((a, b) => (a.attribs[FileAttribute.Duration] ?? 0) - (b.attribs[FileAttribute.Duration] ?? 0))
```

| code | attribute | note |
|------|-----------|------|
|0|`Bitrate`|kbps|
|1|`Duration`|seconds|
|2|`VBR`|1 when the file is VBR encoded|
|3|`Encoder`|rarely sent|
|4|`SampleRate`|Hz, sent for lossless files|
|5|`BitDepth`|sent for lossless files|

##### events
You can also handle results as they arrive with events
```ts
client.on('found', res => {}) // any search result
client.on(`found:${req}`, res => {}) // or only a specific request
```

#### download(options): Download

Asks a peer for a file. Returns the running download right away, without waiting for the peer:
`await` it for the finished file, read its `stream` for the data as it arrives, or follow its
events. Everything that can go wrong is reported on it, connecting to the peer included.

A `SearchResult` is all it needs, so it is either passed as is or spread to add options to it.

```ts
const { buffer, path } = await client.download({ ...res[0], path: '/tmp/song.mp3' })
```

How the file is asked for is not your problem: the peer is asked to queue it (`QueueUpload`), which
is what current Soulseek clients speak, and a peer that answers nothing about a queue is asked
again the way clients did before it existed (`TransferRequest` direction 0). What that peer
understands is then remembered, so the next download from it goes straight to it.

##### options
| key | required | value | default | note |
|-----|----------|-------|---------|------|
|user|true|Peer holding the file|
|file|true|Full path of the file on the peer side|
|size||Size the search result announced|
|path||Complete path where file will be stored (if you want read it later)|/tmp/slsk/{{user}}\_{{originalName}}|
|offset||Bytes already downloaded, to resume a partial download|0|`path` is appended to instead of overwritten|
|timeout||ms without any progress after which the download fails|`downloadTimeout` of the client|queue updates count as progress, use a `signal` for a deadline nothing resets|
|signal||`AbortSignal` that cancels the download when it is aborted|

##### awaiting it resolves with
| key | value |
|-----|-------|
|path|Path where the file has been written|
|buffer|Buffer of the received data, the whole file unless the download was resumed|
|receivedBytes|Bytes on disk, `offset` included|
|size|Size the peer announced, `undefined` when it announced none|

##### following one transfer
```ts
const download = client.download({ ...res[0], path })

download.on('status', status => console.log(status)) // queued, connected, downloading, complete
download.on('interrupted', ({ receivedBytes }) => console.log(`dropped at ${receivedBytes}, retrying`))
download.on('queue', place => console.log(`place ${place} in the queue`))
download.on('progress', ({ progress }) => console.log(`${Math.round((progress ?? 0) * 100)}%`))
download.on('failed', err => console.error(err))

const result = await download // or await download.promise
```

| member | value |
|--------|-------|
|`status`|`requested`, `queued`, `connected`, `downloading`, `interrupted`, `complete`, `failed` or `cancelled`|
|`promise`|resolves with the result, rejects when the transfer fails. Awaiting the download awaits it|
|`stream`|data as it is received, read it before the transfer starts (HTTP 206 and the like)|
|`cancel(reason?)`|gives up on the transfer: the promise rejects with a `DownloadCancelledError`|
|`size`, `expectedSize`, `totalBytes`, `isSizeKnown`|what the peer announced, what the search result said, the best of the two, and which of them it is|
|`user`, `file`, `path`, `offset`, `receivedBytes`, `isSettled`, `isComplete`|what the transfer is about and how far it got|

##### resuming a download
```ts
const offset = (await fs.promises.stat(path)).size
const down = await client.download({ ...file, path, offset })
```

##### streaming a download
```ts
client.download(file).stream.pipe(res)
```

##### giving up on a peer and trying another one
Nothing has to be sent to the peer to cancel a queued file, and a transfer it announces later is
refused, so a download can be handed over to another source at any time.

```ts
const sources = res.filter(it => it.file.endsWith('song.mp3'))

for (const source of sources) {
  const download = client.download({ ...source, path, timeout: 30000 })
  try {
    return await download
  } catch (err) {
    console.log(`${source.user} did not deliver: ${err.message}`)
  }
}
```

A download also takes an `AbortSignal`, which is the way to put a deadline on the whole transfer
rather than on its inactivity: `client.download({ ...file, signal: AbortSignal.timeout(60000) })`.

##### interrupted transfers

A peer that hangs up mid file, or that simply stops sending, does not strand the download:

- the file connection is dropped after `transferTimeout` ms of silence, so a transfer that stalls
  is noticed instead of hanging forever
- a transfer that ends short of the size the peer announced is __not__ reported as complete
- the file is asked for again, up to `downloadRetries` times, and the offset sent to the peer is
  everything received so far, so the bytes already downloaded are not asked for twice
- when the attempts run out the download fails with `Transfer interrupted at x/y bytes, …`

The peer connection is re-opened for the retry if it dropped too, so a transfer survives losing
both connections.

#### downloads
The downloads currently running.

#### getUserInfo(user, timeout?): Promise\<UserInfo\>

Asks a peer what it tells about itself, connecting to it first when needed. Rejects when the peer
cannot be reached or did not answer before `timeout` ms (10000 by default).

```ts
const info = await client.getUserInfo('jambon')
// {
//   user: 'jambon',
//   description: 'only lossless here',
//   picture: <Buffer ...>,   // undefined when the peer has none
//   uploadSlots: 2,
//   queueSize: 42,
//   slotsFree: false,
//   uploadPermitted: UploadPermission.Everyone
// }
```

| key | value | note |
|-----|-------|------|
|user|Peer the info is about|
|description|Free text the peer set as its description|Empty when it has none|
|picture|Picture the peer shares|`undefined` when it sent none|
|uploadSlots|Number of upload slots of the peer|
|queueSize|Files queued for upload on the peer side|Same information as `queueLength` in a search result|
|slotsFree|true when a slot is free to upload immediately|
|uploadPermitted|Who the peer accepts uploads from (`UploadPermission`)|`undefined` when the peer did not send the field|

Peers asking *us* the same question are answered with the `userInfo` option of the client, so a
description of your own is one option away:

```ts
const client = new SlskClient({
  userInfo: { description: 'shared from a NodeJS client', queueSize: 0 }
})
```

#### connectToUser(user, timeout?): Promise\<Peer\>
Connects to a peer, directly and through the server at the same time, and resolves with whichever
answers first. `download()` calls it when needed, so you rarely have to.

#### shares
The [share index](#sharing) of the client, to inspect or change what is shared. Available as soon
as the client is constructed, so providers can be added before `login()` as well as after:

```ts
const client = new SlskClient()
client.shares.addProvider(myProvider) // listed by the login
await client.login('username', 'password')

client.shares.addProvider(anotherProvider) // added later
await client.refreshShares()               // lists it and announces the new counts
```

#### sharesReady: Promise\<void\>

Resolves once the first share listing is over and its counts have been announced to the server,
rejects when that listing failed. Nobody has to await it, the events say the same thing:

```ts
client.on('shares-ready', ({ folders, files }) => console.log(`sharing ${files} files`))
client.on('shares-error', err => console.error('cannot list the shares', err))
```

Searches reaching us before it resolves find nothing — there is nothing indexed yet.

#### username
Name this client logs in as, empty until `login()` is called.

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
|`download-progress`|`{ user, file, receivedBytes, totalBytes?, sizeAnnounced, progress? }`|progress of a running download. `sizeAnnounced` is false while `totalBytes` is only the size the search result announced|
|`download-queue`|`{ user, file, place }`|our place in the upload queue of the peer|
|`download-interrupted`|`{ user, file, receivedBytes, size?, attempts }`|a transfer stopped early and is being asked for again from there|
|`upload-queued`|`{ user, file, place }`|a peer asked for one of our files, `place` is where it waits (0 when it starts right away)|
|`upload-progress`|`{ user, file, sentBytes, totalBytes, progress }`|progress of a file being sent|
|`upload-complete`|`{ user, file, sentBytes }`|a file has been sent whole|
|`upload-failed`|`{ user, file, error }`|a file could not be sent, the peer has been told|
|`server-error`|`Error`|error on the connection to the slsk server|
|`server-disconnect`|`{ reconnecting }`|the connection to the slsk server is gone. `reconnecting` is false when the client will not log in again, which makes it the moment to `destroy()` it|
|`server-reconnect`|—|logged in again after a lost connection|
|`listen-error`|`Error`|error on the incoming peer connections server|
|`peer-error`|`Error, user`|error on a peer connection|
|`shares-ready`|`{ folders, files }`|the first share listing is over and announced|
|`shares-error`|`Error`|the first share listing failed|

```ts
client.on('download-progress', ({ file, progress }) => {
  console.log(file, Math.round((progress ?? 0) * 100) + '%')
})
```

The connection to the slsk server uses TCP keepalive and is re-established with a growing delay
when it drops, which `reconnect: false` turns off. Credentials the server refuses stop it, since
retrying them would only hammer the server: `server-error` then carries a `LoginRefusedError` and
`server-disconnect` says `reconnecting: false`. Peer connections, searches and downloads are left
alone while the server is unreachable, peers are connected to directly.

## Sharing

Peers search and browse your shares over the distributed network. Everything shared goes through a
share provider, `fsShareProvider` for folders of the local file system:

```ts
import { SlskClient, fsShareProvider } from 'slsk-client'

const client = new SlskClient({ shares: fsShareProvider({ folders: ['/home/me/music'] }) })
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
  attribs?: FileAttributes
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

### Serving the files

Sharing a file list and sending the files are two different things: a client denies every transfer
until `uploads` says otherwise.

```ts
const client = new SlskClient({
  shares: fsShareProvider({ folders: ['/home/me/music'] }),
  uploads: { slots: 2, queueLimit: 50 }
})

client.on('upload-queued', ({ user, file, place }) => console.log(`${user} waits at ${place}`))
client.on('upload-progress', ({ file, progress }) => console.log(file, progress))
client.on('upload-complete', ({ user, file }) => console.log(`sent ${file} to ${user}`))
```

|key|value|default|
|---|-----|-------|
|`slots`|How many files are sent at the same time|1|
|`queueLimit`|How many files one peer may keep waiting|100|

What happens when a peer asks for a file:

- the path it sends is resolved against the index, so it can only ever reach a file that was
  advertised to it: an unknown one is refused with `File not shared.`
- the file goes into a single queue, oldest request first, and the peer is told its place when it
  asks for it (`PlaceInQueueRequest`)
- when a slot frees, the size is read from the provider again (`stat()`), the transfer is
  announced (`TransferRequest`), and the bytes are read from `read({ start })` — the peer says
  where to start, so a peer resuming a partial file only gets the rest
- the bytes go out at the pace the peer reads them, and a peer that stops reading for
  `transferTimeout` ms loses the slot
- the file connection is opened to the peer, at the address the server reports for it: the peer
  connection it asked on only carries an ephemeral port, never the port it listens on
- a peer that cannot be reached that way is asked, through the server, to open the file connection
  itself. That fallback needs your own listening port to be reachable, since the server hands the
  peer the address it has for you

`client.uploads` lists what is running and waiting, and `slotsFree`, `queueSize` and
`uploadSlots` sent to peers (in a user info answer and next to every search result) are computed
from that same state: a client that serves nothing says so instead of being picked and then
refusing.

A request made the way clients did before the upload queue existed (`TransferRequest` with
direction 0) goes through the same queue: it is answered with the `Queued` refusal every current
client sends, then announced with our own token. Nothing else lets a peer open a file connection
we did not ask for.

## Breaking changes since 2.x

| change | why |
|--------|-----|
|`Download` (the result of `download()`) is now `DownloadResult`|`Download` is the class of a running transfer, which `download()` returns|
|`download()` returns a `Download` instead of a promise, and `startDownload()` and `downloadStream()` are gone|there is one way to download: `await` it for the file, read `.stream` for the bytes as they arrive, listen to it to follow the transfer|
|`download({ file: searchResult })` is now `download({ user, file, size? })`|it only ever read those three fields; a `SearchResult` still works as is (`download(result)`, `download({ ...result, path })`) but `file` is now the file name|
|`DownloadOptions.request` is gone|which request a peer understands is the library's problem: the queue flow is used, and a peer that ignores it is asked the old way|
|`DownloadResult.stream` is gone|a running `Download` exposes one|
|`DownloadProgress` gained `sizeAnnounced`, and a size of 0 coming from a search result is treated as unknown|0 used to mean "already complete"; only the peer can say a file is empty|
|`SearchResult` exposes `attribs` only, `bitrate`, `duration`, `vbr`, `sampleRate` and `bitDepth` are gone|one map keyed by `FileAttribute` instead of a handful of parsed fields plus the codes nobody parsed: `attribs[FileAttribute.Bitrate]`|
|Shared files are described by `ShareEntry` (`{ path, size, id?, attribs? }`) instead of `SharedFileEntry` (`{ key, value }`)|share providers can come from anywhere, not only from a file system|
|The `sharedFolders` option and `Shared.addFolders()` are gone, `shares: fsShareProvider({ folders })` replaces them|one way to share instead of two, and the provider takes the options a folder scan needs (`root`, `fs`, `followSymlinks`, `includeHidden`, `maxDepth`)|
|Shared files are advertised with a virtual path (`music\\song.mp3`) instead of the local one (`/home/me/music/song.mp3`)|local paths, bucket names and row ids stay private|
|`Shared.search()` returns a promise|a provider may answer searches from a database or a search engine|
|`slsk.connect()` and `slsk.disconnect()` are gone, and so is the default export|`new SlskClient(options)` + `login(user, pass)` does the same without a module-level client to keep track of|
|`new SlskClient(options)` takes a single options object, and `client.init()` is gone|`login(user, pass)` does all the connecting, so there is only one call to make|
|`login()` no longer waits for the shares to be listed, await `sharesReady` for that|the slsk server drops a connection that stays unauthenticated while a large share is walked, so the login used to fail with `timeout login`|
|The internal `stack` module is gone|state belongs to a client, so several clients can share a process|
|A lost server connection is reported (`server-disconnect`) and picked up again by default|it used to be invisible: the client looked alive with a dead socket|

## Development

```sh
npm install
npm test              # type check + unit tests
npm run build         # compile TypeScript to dist/
npm run coverage      # unit tests with coverage
npm run test:integration  # integration tests against the real slsk network
```

### Layout

`src/index.ts` is the public client and little else: the options, the getters and the methods
this README documents. The work lives next to what it acts on, and every part reaches the others
through the `ClientContext` the client builds in [`src/context.ts`](src/context.ts).

| | |debug namespace|
|---|---|---|
|[`server/link.ts`](src/server/link.ts)|the connection to the slsk server, the login and the reconnection loop|`slsk:server:link`|
|[`peer/peers.ts`](src/peer/peers.ts)|every connection to another peer: the ones dialled, the ones accepted, the ones the server has a peer open|`slsk:peers`|
|[`upload/serving.ts`](src/upload/serving.ts)|the upload queue, its slots and the files going out|`slsk:upload:serve`|
|[`download/requesting.ts`](src/download/requesting.ts)|how a peer is asked for a file and what happens to a transfer that stops early|`slsk:download:request`|
|[`search/searching.ts`](src/search/searching.ts)|the searches sent, and the ones answered with our shares|`slsk:search`|
|[`share/sharing.ts`](src/share/sharing.ts)|the shared files, their listing and what the server is told about them|`slsk:share`|

### Debug namespaces

Every module logs under its own namespace, so `DEBUG` can be pointed at one part of the client
instead of all of it. `DEBUG=slsk:*` turns on everything, `DEBUG=slsk:peer:*` every peer
connection, `DEBUG=slsk:peers` only how those connections are opened and dropped.

The connections split what they send from what they receive: `slsk:server` and
`slsk:peer:default` log the messages going out, `slsk:server:recv` and `slsk:peer:default:recv`
the ones coming in. The rest are named after the file they live in — `slsk:listen`, `slsk:peer`,
`slsk:peer:file`, `slsk:peer:file:recv`, `slsk:peer:upload`, `slsk:peer:distributed:recv`,
`slsk:download`, `slsk:downloads`, `slsk:upload`, `slsk:uploads`, `slsk:shared`,
`slsk:share:index`, `slsk:share:fs` — and the test mocks log under `slsk:mock:*`.

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
