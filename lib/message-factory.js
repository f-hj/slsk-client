const crypto = require('crypto')
const Message = require('./message.js')
const zlib = require('zlib')

module.exports = {
  to: {
    peer: {
      pierceFw: (token) => {
        return new Message()
          .int8(0) // code pierceFw
          .rawHexStr(token)
      },
      peerInit: (username, type, token) => {
        return new Message()
          .int8(1)
          .str(username)
          .str(type)
          .rawHexStr(token)
      },
      sharedFileList: (number, name, filesCount, filename) => {
        return new Message()
          .int32(5)
          .int32(number) // nb folders
          .str(name)
          .int32(filesCount) // nb files
          .int8(1) // code file
          .str(filename) // filename
          .int32(3000000) // size1
          .int32(0) // size2
          .str('mp3') // ext
          .int32(0)
      },
      fileSearchResult: (files, token, user) => {
        let msg = new Message()
          .str(user)
          .rawHexStr(token)
          .int32(files.length)

        files.forEach(file => {
          msg.int8(0) // code ?
          msg.str(file.value.file)
          msg.int32(file.value.size) // file size
          msg.int32(0) // file size2
          msg.str('ext') // ext
          msg.int32(0) // nbAttrib
        })

        msg.int8(1) // slots
        msg.int32(123) // speed
        msg.int32(0) // in queue

        return new Message()
          .int32(9)
          .writeBuffer(zlib.deflateSync(msg.data))
      },
      transferRequest: (file, token) => {
        return new Message()
          .int32(40) // code
          .int32(0) // direction
          .rawHexStr(token) // token
          .str(file)
      },
      transferResponse: (token) => {
        return new Message()
          .int32(41)
          .rawHexStr(token)
          .int8(1)
      }
    },
    server: {
      login: (credentials) => {
        return new Message()
          .int32(1)
          .str(credentials.user)
          .str(credentials.pass)
          .int32(160)
          .str(crypto.createHash('md5').update(credentials.user + credentials.pass).digest('hex'))
          .int32(17) // ? if someone can explain these fields (taken from nicotine+)
      },
      setWaitPort: (port) => {
        return new Message()
          .int32(2)
          .int32(port)
      },
      getPeerAddress: (username) => {
        return new Message()
          .int32(3)
          .str(username)
      },
      addUser: (user) => {
        return new Message()
          .int32(5)
          .str(user)
      },
      fileSearch: (query, token) => {
        return new Message()
          .int32(26) // code
          .rawHexStr(token) // token as int
          .str(query) // req
      },
      setStatus: (status) => {
        return new Message()
          .int32(28)
          .int32(status)
      },
      sharedFoldersFiles: (folderCount, fileCount) => {
        return new Message()
          .int32(35)
          .int32(folderCount)
          .int32(fileCount)
      },
      haveNoParents: (flag) => {
        return new Message()
          .int32(71)
          .int32(flag)
      },
      parentIp: (ip) => {
        return new Message()
          .int32(73)
          .int8(ip[0])
          .int8(ip[1])
          .int8(ip[2])
          .int8(ip[3])
      }
    }
  },
  from: {
    peer: {
      fileSearchResult: (buffer) => {
        let msg = new Message(buffer)
        let user = msg.str()
        let currentToken = msg.rawHexStr(4)
        let nbFiles = msg.int32()
        let files = []
        for (let i = 0; i < nbFiles; i++) {
          msg.int8() // code
          let filename = msg.str()
          let filesize = msg.int32()
          msg.int32() // filesize2
          msg.str() // ext
          let nbAttrib = msg.int32()
          let attribs = {}
          for (let attrib = 0; attrib < nbAttrib; attrib++) {
            attribs[msg.int32()] = msg.int32()
          }

          files.push({
            user: user,
            file: filename,
            size: filesize,
            attribs
          })
        }
        let slots = msg.int8()
        let speed = msg.int32()

        return {
          currentToken: currentToken,
          files: files,
          slots: slots,
          speed: speed
        }
      }
    }
  }
}
