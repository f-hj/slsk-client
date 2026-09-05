# Soulseek NodeJS client

![slsk-client logo](https://fruitice.fr/logo-slsk.png)

[![CI](https://github.com/f-hj/slsk-client/actions/workflows/ci.yml/badge.svg)](https://github.com/f-hj/slsk-client/actions/workflows/ci.yml)
[![GitHub stars](https://img.shields.io/github/stars/f-hj/slsk-client.svg)](https://github.com/f-hj/slsk-client/stargazers)

A modern NodeJS client for the Soulseek peer-to-peer network, written in TypeScript with a fully promise-based (async/await) API and complete TypeScript type declarations.

## Features

- **File Search**: Search the distributed Soulseek network with exclusion keywords and attribute filters.
- **File Downloads**: Reliable downloads supporting streaming, queueing, automatic retries, and resume on interrupted transfers.
- **File Sharing**: Share files from the local filesystem (`fsShareProvider`), memory (`memoryShareProvider`), or custom providers (e.g. S3 / database).
- **Upload Queue**: Serve shared files with configurable slots and per-peer queue limits.
- **Private Messaging**: Send and receive private messages through the Soulseek server.
- **Self-Documented**: Comprehensive TypeScript types and JSDoc annotations for all options, methods, and events right in your editor.

## Installation

Install from GitHub Packages:

```sh
npm install @f-hj/slsk-client
```

> **Note**: To install packages from GitHub Packages, configure `@f-hj` in your `~/.npmrc` or project `.npmrc`:
> ```ini
> @f-hj:registry=https://npm.pkg.github.com
> ```

## Getting Started

You must already have a Soulseek account before using this module.

```ts
import { SlskClient, FileAttribute } from '@f-hj/slsk-client'

const client = new SlskClient()
await client.login('myUsername', 'myPassword')

// Search for files
const results = await client.search({
  req: 'random track',
  timeout: 4000
})

// Filter or sort results (e.g., 320kbps MP3s)
const bestResult = results
  .filter(r => r.attribs[FileAttribute.Bitrate] === 320)
  .sort((a, b) => (b.speed ?? 0) - (a.speed ?? 0))[0]

// Download
if (bestResult) {
  const download = client.download({
    ...bestResult,
    path: '/path/to/save/song.mp3'
  })

  download.on('progress', ({ progress }) => {
    console.log(`Progress: ${Math.round((progress ?? 0) * 100)}%`)
  })

  const { path, buffer } = await download
  console.log(`Saved to ${path}`)
}
```

## Usage

### Downloading

The `download()` method returns a `Download` instance that can be awaited as a Promise or used as a stream:

```ts
// Follow transfer events
const download = client.download({ ...result, path: '/tmp/song.mp3' })

download.on('status', status => console.log('Status:', status)) // queued, connected, downloading, complete
download.on('queue', place => console.log(`Queue position: ${place}`))
download.on('progress', ({ progress }) => console.log(`${Math.round((progress ?? 0) * 100)}%`))

const res = await download

// Or stream directly (e.g., pipe to an HTTP response or custom write stream)
client.download(result).stream.pipe(writableStream)

// Resuming a partial download
const offset = (await fs.promises.stat(partialPath)).size
await client.download({ ...result, path: partialPath, offset })

// Cancelling with AbortSignal
await client.download({ ...result, signal: AbortSignal.timeout(30000) })
```

### Sharing and Uploading

Files can be shared using built-in or custom share providers:

```ts
import { SlskClient, fsShareProvider, memoryShareProvider } from '@f-hj/slsk-client'

const client = new SlskClient({
  shares: [
    fsShareProvider({ folders: ['/home/me/music'], root: 'music' }),
    memoryShareProvider({ 'jingles\\intro.mp3': introBuffer })
  ],
  // Enable uploading shared files to requesting peers
  uploads: {
    slots: 2,        // Concurrent upload slots
    queueLimit: 50   // Max queued files per peer
  }
})

await client.login('myUsername', 'myPassword')

// Track upload activity
client.on('upload-queued', ({ user, file, place }) => console.log(`${user} queued ${file} at ${place}`))
client.on('upload-progress', ({ user, file, progress }) => console.log(`${file}: ${Math.round(progress * 100)}%`))
client.on('upload-complete', ({ user, file }) => console.log(`Finished uploading ${file} to ${user}`))
```

### Private Messages

```ts
// Receive messages
client.on('private-message', ({ user, message, sentAt, pending }) => {
  console.log(`[${sentAt.toISOString()}] ${user}: ${message}`)
  client.sendPrivateMessage(user, 'Thanks for your message!')
})

// Send a message
client.sendPrivateMessage('anotherUser', 'Hello!')
```

### Client Events

`SlskClient` extends `EventEmitter` with strongly typed events:

```ts
client.on('found', result => console.log('Found:', result.file))
client.on('server-error', err => console.error('Server error:', err))
client.on('server-disconnect', ({ reconnecting }) => console.log('Disconnected, reconnecting:', reconnecting))
client.on('server-reconnect', () => console.log('Reconnected to Soulseek'))
```

## TypeScript Documentation

This library is written natively in TypeScript. All configuration options (`SlskClientOptions`, `DownloadOptions`, `SearchOptions`, `UploadOptions`), return types (`SearchResult`, `DownloadResult`, `UserInfo`), and event payloads are fully typed with detailed JSDoc descriptions.

Use your IDE's hover tooltips and autocomplete (e.g., in VS Code or WebStorm) to explore available options, methods, and event payloads without needing external reference tables.

## Development

```sh
npm install
npm test              # Run type checks and unit tests
npm run build         # Build TypeScript to dist/
npm run coverage      # Run unit tests with coverage
npm run test:integration  # Integration tests against real Soulseek network (requires SLSK_USER & SLSK_PASS)
```

### Debugging

The library uses the `debug` package. Set the `DEBUG` environment variable to inspect internal logs:

```sh
DEBUG=slsk:* node app.js        # Log everything
DEBUG=slsk:server node app.js   # Server connection logs
DEBUG=slsk:peer:* node app.js   # Peer connection logs
DEBUG=slsk:download node app.js # Download logs
DEBUG=slsk:upload node app.js   # Upload logs
```

## Protocol Compliance & Documentation

- [Protocol Compliance Report](docs/PROTOCOL-COMPLIANCE.md) — Implementation details and deviations from the Soulseek protocol
- [Nicotine+ SLSK Protocol Documentation](https://nicotine-plus.org/doc/SLSKPROTOCOL.html)
- [MLDonkey Soulseek Protocol Documentation](https://web.archive.org/web/20200806085616/http://ftp.tu-clausthal.de/pub/mirror/ftp.gwdg.de/gnu/ftp/savannah/files/mldonkey/docs/Soulseek/soulseek_protocol.html)

## License

[MIT](LICENSE)
