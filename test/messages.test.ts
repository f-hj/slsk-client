import assert from 'assert'
import Messages from '../src/utils/messages'
import Message from '../src/utils/message'

describe('class Messages', () => {
  it('must parse one message correctly', () => {
    const readed: Message[] = []
    const msgs = new Messages()
    msgs.on('message', msg => readed.push(msg))

    msgs.write(Buffer.from('0a00000006000000636f75636f75', 'hex'))

    assert.strictEqual(readed.length, 1)
  })

  it('must parse two messages correctly', () => {
    const readed: Message[] = []
    const msgs = new Messages()
    msgs.on('message', msg => readed.push(msg))

    msgs.write(Buffer.from('0a00000006000000636f75636f750a00000006000000636f75636f75', 'hex'))

    assert.strictEqual(readed.length, 2)
  })

  it('must not resend incomplete msg', () => {
    const readed: Message[] = []
    const msgs = new Messages()
    msgs.on('message', msg => readed.push(msg))

    msgs.write(Buffer.from('0a00000006000000636f75636f', 'hex'))

    assert.strictEqual(readed.length, 0)
  })

  it('must work with rest', () => {
    const readed: Message[] = []
    const msgs = new Messages()
    msgs.on('message', msg => readed.push(msg))

    msgs.write(Buffer.from('0a00000006000000636f75636f', 'hex'))
    msgs.write(Buffer.from('75', 'hex'))

    assert.strictEqual(readed.length, 1)
    assert.strictEqual(new Message(readed[0].data.subarray(4)).str(), 'coucou')
  })

  it('must work with a chunk smaller than 4 bytes', () => {
    const readed: Message[] = []
    const msgs = new Messages()
    msgs.on('message', msg => readed.push(msg))

    msgs.write(Buffer.from('0a00', 'hex'))
    msgs.write(Buffer.from('000006000000636f75636f75', 'hex'))

    assert.strictEqual(readed.length, 1)
  })

  it('must forget the rest after a reset', () => {
    const readed: Message[] = []
    const msgs = new Messages()
    msgs.on('message', msg => readed.push(msg))

    msgs.write(Buffer.from('0a00000006000000636f75636f', 'hex'))
    msgs.reset()
    msgs.write(Buffer.from('75', 'hex'))

    assert.strictEqual(readed.length, 0)
  })
})
