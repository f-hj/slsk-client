const crypto = require('crypto')
const Message = require('./message.js')

module.exports = {
  to: {

    peer: {
      pierceFw: (token) => {
        return new Message()
          .int8(0) // code pierceFw
          .rawHexStr(token)
      },
      peerInit: (username) => {
        return new Message()
          m.int8(1)
          .str(username)
          .str('F')
          .int32(0)
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
          .int32(1) // code
          .str(credentials.user) // user
          .str(credentials.pass) // pass
          .int32(157) // version
          .str(crypto.createHash('md5').update(credentials.user + credentials.pass).digest('hex')) // hash
          .int32(17) // ? if someone can explain these fields (taken from nicotine+)
          .int32(8) // ?
          .int32(2) // ?
          .int32(47624)
      },
      fileSearch: (query, token) => {
        return new Message()
          .int32(26) // code
          .rawHexStr(token) // token as int
          .str(query) // req
      }
    }
  },

  from: {

    peer: {
      fileSearchResult: (buffer) => {
        msg = new Message(buffer)
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
