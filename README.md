# Soulseek NodeJS client

[![Build Status](https://travis-ci.org/f-hj/slsk-client.svg?branch=master)](https://travis-ci.org/f-hj/slsk-client)
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)
[![GitHub stars](https://img.shields.io/github/stars/f-hj/slsk-client.svg)](https://github.com/f-hj/slsk-client/stargazers)

## ⚠ WIP
I'm currently working on this thing, and currently not usable.

Not published on NPM yet.

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
        file: '@@poulet-music/random.mp3',
        freeUpload: true
      }
    ]
    client.download({
      file: res[0]
    }, (err, buffer) => {
      //can res.send(buffer) if you use express
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
|host||choose a different host for Slsk server|
|port||choose a different port|
|incomingPort||Port used for incoming connection||For next version|

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
|freeUpload|Avalaible slots|True if peer have enough slots to get file immediately|

List of files
```json
[
  {
    "user": "jambon",
    "file": "@@jambon-slsk/myfile.m4a",
    "freeUpload": false
  }
]
```

#### download
Return buffered file

#### downloadFile

## Sources

ftp://ftp.tu-clausthal.de/pub/mirror/ftp.gwdg.de/gnu/ftp/savannah/files/mldonkey/docs/Soulseek/soulseek_protocol.html

https://www.museek-plus.org/wiki/SoulseekProtocol

https://github.com/Nicotine-Plus/nicotine-plus
