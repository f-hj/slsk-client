import { ServerAdress } from "."
import net from 'net'
import { Message } from "./message"
import { Messages } from "./messages"
const MessageFactory = require('./message-factory.js')


// TODO: typed event emitter to send events from Messages to functions
class ServerClient {
  public conn: net.Socket

  constructor (serverAddress: ServerAdress) {
    this.conn = net.createConnection(serverAddress)

    let msgs = new Messages()

    this.conn.on('data', data => {
      msgs.read(data, (msg: Message) => {
        console.log(msg)
      })
    })
  }

  login (credentials: {
    user: string,
    pass: string
  }) {
    return new Promise((resolve) => {
      this.on('loginResponse', () => {

      })
      this.conn.write(MessageFactory
        .to.server
        .login(credentials)
        .getBuff())
    })
  }
}

export { ServerClient }