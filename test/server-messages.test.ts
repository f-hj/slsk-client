import assert from 'assert'
import crypto from 'crypto'
import Message from '../src/utils/message'
import messages from '../src/server/messages'

describe('server messages', () => {
  it('builds a login message readable back', () => {
    const buff = messages.login({ user: 'alice', pass: 'secret' }).getBuff()
    const msg = new Message(buff)

    msg.int32() // size
    assert.strictEqual(msg.int32(), 1) // code
    assert.strictEqual(msg.str(), 'alice')
    assert.strictEqual(msg.str(), 'secret')
    assert.strictEqual(msg.int32(), 160) // version
    assert.strictEqual(msg.str(), crypto.createHash('md5').update('alicesecret').digest('hex'))
  })

  it('builds a setWaitPort message', () => {
    const buff = messages.setWaitPort(2234).getBuff()
    const msg = new Message(buff)

    msg.int32() // size
    assert.strictEqual(msg.int32(), 2) // code
    assert.strictEqual(msg.int32(), 2234)
  })

  it('builds a fileSearch message', () => {
    const buff = messages.fileSearch('moby play', '0a0b0c0d').getBuff()
    const msg = new Message(buff)

    msg.int32() // size
    assert.strictEqual(msg.int32(), 26) // code
    assert.strictEqual(msg.rawHexStr(4), '0a0b0c0d')
    assert.strictEqual(msg.str(), 'moby play')
  })

  it('builds a haveNoParents message with a one byte flag', () => {
    assert.strictEqual(
      messages.haveNoParents(true).getBuff().toString('hex'),
      '0500000047000000' + '01'
    )
    assert.strictEqual(
      messages.haveNoParents(false).getBuff().toString('hex'),
      '0500000047000000' + '00'
    )
  })

  it('builds a connectToPeer message', () => {
    const buff = messages.connectToPeer('0a0b0c0d', 'alice', 'P').getBuff()
    const msg = new Message(buff)

    msg.int32() // size
    assert.strictEqual(msg.int32(), 18) // code
    assert.strictEqual(msg.rawHexStr(4), '0a0b0c0d')
    assert.strictEqual(msg.str(), 'alice')
    assert.strictEqual(msg.str(), 'P')
  })

  it('builds a cantConnectToPeer message', () => {
    const buff = messages.cantConnectToPeer('0a0b0c0d', 'alice').getBuff()
    const msg = new Message(buff)

    msg.int32() // size
    assert.strictEqual(msg.int32(), 1001) // code
    assert.strictEqual(msg.rawHexStr(4), '0a0b0c0d')
    assert.strictEqual(msg.str(), 'alice')
  })

  it('builds branchLevel and branchRoot messages', () => {
    const level = new Message(messages.branchLevel(2).getBuff())
    level.int32() // size
    assert.strictEqual(level.int32(), 126) // code
    assert.strictEqual(level.int32(), 2)

    const root = new Message(messages.branchRoot('parent').getBuff())
    root.int32() // size
    assert.strictEqual(root.int32(), 127) // code
    assert.strictEqual(root.str(), 'parent')
  })
})
