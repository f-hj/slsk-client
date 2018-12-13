# Soulseek NodeJS client

<img align="right" src="https://fruitice.fr/logo-slsk.png"/>

[![Build Status](https://travis-ci.org/f-hj/slsk-client.svg?branch=master)](https://travis-ci.org/f-hj/slsk-client)
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)
[![GitHub stars](https://img.shields.io/github/stars/f-hj/slsk-client.svg)](https://github.com/f-hj/slsk-client/stargazers)

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
```js
const slsk = require('slsk-client')
slsk.connect({
  user: 'username',
  pass: 'password'
}, (err, client) => {
  client.search({
    req: 'random',
    timeout: 2000
  }, (err, res) => {
    if (err) return console.log(err)
    res = [
      {
        user: 'poulet',
        file: '@@poulet-files/random.mp3',
        size: 6437362,
        slots: true,
        bitrate: 320,
        speed: 1251293
      }
    ]
    client.download({
      file: res[0],
      path: __dirname + '/random.mp3'
    }, (err, data) => {
      //can res.send(data.buffer) if you use express
    })
  })
})
```

## API
### slsk
#### connect
##### argument
| key | required | value | default | note |
|-----|----------|-------|---------|------|
|user| true |Your username|
|pass| true| Your password|
|host||choose a different host for Slsk server|server.slsknet.org|
|port||choose a different port|2242|
|incomingPort||Port used for incoming connection|2234|
|sharedFolders||Folders to be shared|[]|

##### callback
Return client (see just here ⬇)

### client
#### search
##### argument
| key | required | value | default | note |
|-----|----------|-------|---------|------|
|req|true|Sent to slsk server/peers to search file, use space to add keyword|
|timeout||Slsk doesn't sent when search is finished. We ignore request after this time|4000|

##### callback

|key | value | note |
|-----|-------|------|
|user|Peer name of slsk|
|file|Full path of peer file|
|size|Size of file|
|slots|Available slots|true if peer have enough slots to get file immediately|
|bitrate|Bitrate of current file|Can be undefined if not sent by client|
|speed|Speed of peer|Provided by peer, don't know what is it exactly|

List of files
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
You can handle results with events
```js
client.on('found') // any search result
client.on('found:${req}') // or only a specific request
```

#### download

Return buffered file, callback called when file is completely downloaded. (Stored in RAM)

##### argument
| key | required | value | default | note |
|-----|----------|-------|---------|------|
|file|true|File sent when searched|
|path||Complete path where file will be stored (if you want read it later)|/tmp/slsk/{{originalName}}|

##### callback
| key | value |
|-----|-------|
|buffer|Complete buffer of file|

#### downloadStream
WARNING: please report any issue with this function
Return streamed file, wait for parts to be downloaded, can be used for HTTP 206 (partial content) for example

##### argument
| key | required | value | default | note |
|-----|----------|-------|---------|------|
|file|true|File sent when searched|

##### callback
Readable stream

## Tests

Use env variables for tests
- `DEBUG=slsk:*` to display debug messages
- `SLSK_USER=MyUsername`
- `SLSK_PASS=MyPassword`

## Sources

ftp://ftp.tu-clausthal.de/pub/mirror/ftp.gwdg.de/gnu/ftp/savannah/files/mldonkey/docs/Soulseek/soulseek_protocol.html

https://www.museek-plus.org/wiki/SoulseekProtocol

https://github.com/Nicotine-Plus/nicotine-plus
