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

### Not implemented

This stuff is not implemented (yet?), but I wait your __PR__!
- Chat
- Sharing (+ Upnp opened port)

## ⚠ Infos
You must choose file with slots: true, or you'll wait a long time before downloading it.

I advise you to sort files by speed and select the best one (OK, speed is sent by client and can be fake, but the big majority is real).

## Getting started
```ts
import slsk from 'slsk-client'
// or: const slsk = require('slsk-client')

const client = await slsk.connect({
  user: 'username',
  pass: 'password'
})

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
### slsk
#### connect(options): Promise\<SlskClient\>
##### options
| key | required | value | default | note |
|-----|----------|-------|---------|------|
|user| true |Your username|
|pass| true| Your password|
|host||choose a different host for Slsk server|server.slsknet.org|
|port||choose a different port|2242|
|incomingPort||Port used for incoming connection|2234|
|sharedFolders||Folders to be shared|[]|
|timeout||Time in ms before the login attempt fails|2000|

Resolves with a client (see just here ⬇), rejects when the connection fails, the credentials are refused or the login times out.

### client
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

#### download(options): Promise\<Download\>

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

#### downloadStream(options): Readable
WARNING: please report any issue with this function
Returns a readable stream, data is pushed as parts are downloaded, can be used for HTTP 206 (partial content) for example.
The stream is destroyed with an error when the peer reports a failure.

##### options
Same as `download(options)`.

#### connectToUser(user, timeout?): Promise\<Peer\>
Connects to a peer, directly and through the server at the same time, and resolves with whichever
answers first. `download()` calls it when needed, so you rarely have to.

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
