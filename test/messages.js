/* eslint-env mocha */

const assert = require('assert')
const Messages = require('../lib/messages.js')

describe('class Messages', () => {
  it('must parse one message correctly', () => {
    let readed = []
    let msgs = new Messages()
    msgs.on('message', msg => readed.push(msg))

    msgs.write(Buffer.from('0a00000006000000636f75636f75', 'hex'))

    assert.strictEqual(readed.length, 1)
  })

  it('must parse two messages correctly', () => {
    let readed = []
    let msgs = new Messages()
    msgs.on('message', msg => readed.push(msg))

    msgs.write(Buffer.from('0a00000006000000636f75636f750a00000006000000636f75636f75', 'hex'))

    assert.strictEqual(readed.length, 2)
  })

  it('must not resend incomplete msg', () => {
    let readed = []
    let msgs = new Messages()
    msgs.on('message', msg => readed.push(msg))

    msgs.write(Buffer.from('0a00000006000000636f75636f', 'hex'))

    assert.strictEqual(readed.length, 0)
  })

  it('must work with rest', () => {
    let readed = []
    let msgs = new Messages()
    msgs.on('message', msg => readed.push(msg))

    msgs.write(Buffer.from('0a00000006000000636f75636f', 'hex'))
    msgs.write(Buffer.from('75', 'hex'))

    assert.strictEqual(readed.length, 1)
  })
})
