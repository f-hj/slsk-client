//internal
const net = require('net')
const zlib = require('zlib')
const fs = require('fs')

//external
const hex = require('hex')

var client = net.createConnection({
  host: 'server.slsknet.org',
  port: 2242
})

// TODO upnp port for client connect
/*var server = net.createServer()
server.listen(54792, () => {
  console.log('server bound');
});*/

var peers = []

let gettingFile = false
let gettingFileUser
let gettingFileName

client.on('connect', function() {
  console.log('connect')
  //                      length       code         l user        user                        l pass        pass                      version
  let buf = Buffer.from('4f000000' + '01000000' + '0c000000' + '49416d576562536572766572' + '0b000000' + '49416d50617373776f7264' + '9d000000' +
  // l hash     hash                                                                  version
  '20000000' + '3334326566663061366637323062623335666139643366643264666162303163' + '11000000' + '08000000' + '02000000' + 'ba080000', 'hex')
  client.write(buf)
  /*setTimeout(() => {
    console.log('port')
    let bufPort = Buffer.from('08000000' + '02000000' + '08da0000')
    client.write(bufPort)
  }, 1000)*/
  setTimeout(() => {
    console.log('search')
    //                      length        code        ticket      l content     content
    let buf2 = Buffer.from('15000000' + '1a000000' + '0de2e116' + '09000000' + '6d6f627920706c6179', 'hex')

    //let buf2 = Buffer.from('1d000000' + '26000000' + '01010101' + '09000000' + '6d6f627920706c6179', 'hex')
    client.write(buf2)
  }, 2000)
})

let savedData

client.on('data', function(data) {
  //data = data.slice(0, 100)
  if (savedData) {
    data = Buffer.concat([savedData, data])
  }
  // must recover saved datas
  //hex(data)
  let pointer = 0
  while (pointer < data.length) {
    let oPointer = pointer
    if (pointer + 4 > data.length) {
      pointer += 4
      break
    }
    let size = data.readUInt32LE(pointer)
    //console.log('pointer: ' + pointer.toString(16) + ' length: ' + data.length.toString(16) + ' size: ' + size.toString(16))

    if (pointer + size > data.length) {
      //save data after pointer
      //console.log('save datas')
      //savedData = data.slice(pointer, data.length)
      pointer += 4
      break
    }

    if (size == 0) {
      pointer += 4
      continue
    }

    pointer += 4
    if (data.readUInt32LE(pointer) == 18) {
      //hex(data)
      pointer += 4
      let sUsername = data.readUInt32LE(pointer)
      pointer += 4
      let username = data.toString('utf8', pointer, pointer + sUsername)
      pointer += sUsername
      let sType = data.readUInt32LE(pointer)
      pointer += 4
      let type = data.toString('utf8', pointer, pointer + sType)
      pointer += sType
      let ip = []
      for (let i = 0 ; i < 4 ; i++) {
        ip.push(data.readUInt8(pointer + i))
      }

      // What the fuck Soulseek? Why this shiet is revert? I lost 2 days on this!
      let host = ip[3] + '.' + ip[2] + '.' + ip[1] + '.' + ip[0]

      pointer += 4
      let port = data.readUInt32LE(pointer)
      pointer += 4
      let token = data.toString('hex', pointer, pointer + 4)
      //let token = data.readUInt32LE(pointer)
      //console.log('ConnectToPeer ' + username + ' ' + type + ' ' + host + ':' + port + ' ' + token)

      if (gettingFile && gettingFileUser === username && type == 'F') {
        downloadFile(gettingFileUser, gettingFileName, token)
        return
      }

      //do this async for next times
      let conn = net.createConnection({
        host,
        port
      }, () => {
        //console.log('Connected to ' + username)
        let buf = Buffer.from('05' + '00000000' + token, 'hex')
        conn.write(buf)
      })

      peers.push({
        username,
        conn,
        token,
        host,
        port
      })

      conn.on('data', d => {
        if (gettingFile && gettingFileUser !== username) return
        console.log(username)
        hex(d)
        let p = 0
        let ps = d.readUInt32LE(p)
        p += 4
        let code = d.readUInt32LE(p)
        p += 4
        console.log(ps)
        console.log(code)
        console.log('length: ' + data.length.toString(16) + ' size: ' + ps.toString(16))
        if (code === 9) {
          console.log('FileSearchResult')
          //from p to ps + 4
          let content = d.slice(p, ps + 4)
          //hex(content)
          zlib.unzip(content, (err, buffer) => {
            if (!err) {
              hex(buffer)
              let zpoint = 0

              let szUser = buffer.readUInt32LE(zpoint)
              zpoint += 4
              let zuser = buffer.toString('utf8', zpoint, zpoint + szUser)
              zpoint += szUser
              let token = buffer.readUInt32LE(zpoint)
              zpoint += 4
              let nbFiles = buffer.readUInt32LE(zpoint)
              zpoint += 4
              console.log('Files: ' + nbFiles)
              for (var i = 0; i < nbFiles; i++) {
                let code = buffer.readUInt8(zpoint)
                zpoint += 1
                let sFilename = buffer.readUInt32LE(zpoint)
                zpoint += 4
                let filename = buffer.toString('utf8', zpoint, zpoint + sFilename)
                zpoint += sFilename
                let fileSize = buffer.readUInt32LE(zpoint)
                zpoint += 4
                let fileSize2 = buffer.readUInt32LE(zpoint)
                zpoint += 4
                let sExt = buffer.readUInt32LE(zpoint)
                zpoint += 4
                let ext = buffer.toString('utf8', zpoint, zpoint + sExt)
                zpoint += sExt
                let nbAttrib = buffer.readUInt32LE(zpoint)
                zpoint += 4
                //we don't care about attributes
                zpoint += nbAttrib * 8
                console.log('    File: ' + filename + ' size: ' + fileSize + ' ext: ' + ext + ' nbAttrib: ' + nbAttrib)
                if (gettingFile) return
                if (i === 0) {
                  getFile(username, filename)
                }
              }
            } else {
              console.log(err)
            }
          });
        } else if (code === 41) {
          let nToken = d.toString('hex', p, p + 4)
          p += 4
          let allowed = d.readUInt8(p)
          p += 1
          if (allowed === 0) {
            let sReason = d.readUInt32LE(p)
            p += 4
            let reason = d.toString('utf8', p, p + sReason)
            console.log('TransferResponse ' + username + ' token: ' + nToken + ' allowed: ' + allowed + ' reason: ' + reason)
            if (reason === 'Queued') {
              /*setInterval(() => {
                console.log('PlaceInQueueRequest')
                let fileHex = Buffer.from(gettingFileName, 'utf8').toString('hex')
                //                      length        code        l filename    filename
                let bReq = Buffer.from('00000000' + '33000000' + '00000000' + fileHex, 'hex')
                let fileHexSize = fileHex.length / 2
                bReq.writeUInt32LE(8 + fileHexSize, 0)
                bReq.writeUInt32LE(fileHexSize, 8)
                hex(bReq)
                conn.write(bReq)
              }, 5000)*/
            }
          } else {
            console.log('TransferResponse ' + username + ' token: ' + nToken + ' allowed: ' + allowed)
            // I must send ConnectToPeer with F
          }
        } else if (code === 40) {
          let dir = d.readUInt32LE(p)
          p += 4
          let rToken = d.toString('hex', p, p + 4)
          p += 4
          let sFile = d.readUInt32LE(p)
          p += 4
          let file = d.toString('utf8', p, p + sFile)
          p += sFile
          if (dir === 1) {
            let size = d.readUInt32LE(p)
            p += 4
          }

          console.log('TransferRequest ' + username + ' token: ' + token + ' filename: ' + file)
          if (username === gettingFileUser && file === gettingFileName) {
            console.log('TransferResponse')
            let b = Buffer.from('09000000' + '29000000' + rToken + '01', 'hex')
            hex(b)
            conn.write(b)
            // I will receive ConnectToPeer F
          }
        }
      })

      conn.on('error', err => {
        //console.log('Error to ' + username + ' ' + err.code)
      })

      conn.on('end', () => {
        //console.log('Ending ' + username)
      })

      conn.on('timeout', () => {
        //console.log('Timeout ' + username)
      })
    }

    //console.log()
    //console.log()
    pointer = oPointer + size + 4
  }
})

function getFile(user, file) {
  gettingFile = true
  gettingFileUser = user
  gettingFileName = file
  console.log(user + ' ' + file)
  console.log('Search user')
  peers.forEach(peer => {
    if (peer.username === user) {
      console.log('Sending request')
      let fileHex = Buffer.from(file, 'utf8').toString('hex')
      //                      length       code         direction    token       l filename    filename
      let buff = Buffer.from('00000000' + '28000000' + '00000000' + '64000000' + '00000000' + fileHex, 'hex')
      let fileHexSize = fileHex.length / 2
      buff.writeUInt32LE(16 + fileHexSize, 0)
      buff.writeUInt32LE(fileHexSize, 16)
      hex(buff)
      console.log()
      peer.conn.write(buff)
    }
  })
}

function downloadFile(user, file, token) {
  console.log('downloadFile ' + user + ' ' + file)
  console.log('Search user')
  peers.forEach(peer => {
    if (peer.username === user) {
      let conn = net.createConnection({
        host: peer.host,
        port: peer.port
      }, () => {
        //console.log('Connected to ' + username)
        let buf = Buffer.from('05' + '00000000' + token, 'hex')
        conn.write(buf)
      })

      fs.writeFile('t.mp3', '')

      let received = false
      conn.on('data', data => {
        if (!received) {
          conn.write(Buffer.from('00000000' + '00000000', 'hex'))
          received = true
        } else {
          fs.appendFile('t.mp3', data)
        }
        hex(data)
      })
    }
  })
}

//message length  code      content
//4 bytes         4 bytes   ...
