/* eslint-env mocha */

const assert = require('assert')

const Messages = require('../lib/messages.js')

describe('class Messages', () => {
  it('must parse one message correctly', () => {
    let msgs = new Messages(Buffer.from('0a00000006000000636f75636f75', 'hex'))
    assert.equal(msgs.length, 1)
  })

  it('must parse two messages correctly', () => {
    let msgs = new Messages(Buffer.from('0a00000006000000636f75636f750a00000006000000636f75636f75', 'hex'))
    assert.equal(msgs.length, 2)
  })

  it('must not resend incomplete msg', () => {
    let msgs = new Messages(Buffer.from('0a00000006000000636f75636f', 'hex'))
    assert.equal(msgs.length, 0)
  })

  it('must keep rest (in peace?)', () => {
    let msgs = new Messages(Buffer.from('0a00000006000000636f75636f', 'hex'))
    assert.equal(msgs.length, 0)
    assert.equal(msgs.rest.toString('hex'), '0a00000006000000636f75636f')
  })

  it('must work with rest', () => {
    let rest = Buffer.from('0a00000006000000636f75636f', 'hex')
    let msgs = new Messages(Buffer.from('75', 'hex'), rest)
    assert.equal(msgs.length, 1)
  })
})
