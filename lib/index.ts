interface ServerAdress {
  host: string
  port: number
}

class SlskClient {
  constructor (server: ServerAdress = {
    host: '',
    port: 0
  }, sharedFolders: string[] = []) {

  }

  init () {

  }
}

export { SlskClient, ServerAdress }