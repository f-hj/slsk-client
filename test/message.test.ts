import assert from 'assert'
import Message from '../src/utils/message'

describe('class Message', () => {
  describe('write', () => {
    it('correct int8', () => {
      const msg = new Message()
      assert.strictEqual(msg.int8(1).getBuff().toString('hex'), '0100000001')
    })

    it('correct int32', () => {
      const msg = new Message()
      assert.strictEqual(msg.int32(1).getBuff().toString('hex'), '0400000001000000')
    })

    it('correct string', () => {
      const msg = new Message()
      assert.strictEqual(msg.str('coucou').getBuff().toString('hex'), '0a00000006000000636f75636f75')
    })

    it('correct raw hex string', () => {
      const msg = new Message()
      assert.strictEqual(msg.rawHexStr('0a0b0c0d').getBuff().toString('hex'), '040000000a0b0c0d')
    })

    it('correct buffer', () => {
      const msg = new Message()
      assert.strictEqual(msg.writeBuffer(Buffer.from('cafe', 'hex')).getBuff().toString('hex'), '02000000cafe')
    })

    it('correct msg', () => {
      const msg = new Message()
      assert.strictEqual(msg.int8(1).int32(666).str('coucou').getBuff().toString('hex'), '0f000000019a02000006000000636f75636f75')
    })

    it('correct int64', () => {
      const msg = new Message()
      assert.strictEqual(msg.int64(1).getBuff().toString('hex'), '080000000100000000000000')
    })

    it('correct int64 over 4 GiB', () => {
      const msg = new Message()
      assert.strictEqual(
        msg.int64(6 * 1024 * 1024 * 1024).getBuff().toString('hex'),
        '08000000' + '0000008001000000' // 0x180000000 little endian
      )
    })

    it('is not writable anymore after getBuff', () => {
      const msg = new Message()
      msg.int8(1).getBuff()
      assert.strictEqual(msg.writable, false)
    })
  })

  describe('read', () => {
    it('must read correct msg', () => {
      const buff = Buffer.from('0f000000019a02000006000000636f75636f75', 'hex')
      const msg = new Message(buff)
      assert.strictEqual(msg.int32(), 15)
      assert.strictEqual(msg.int8(), 1)
      assert.strictEqual(msg.int32(), 666)
      assert.strictEqual(msg.str(), 'coucou')
    })

    it('must read a raw hex string', () => {
      const msg = new Message(Buffer.from('0a0b0c0d', 'hex'))
      assert.strictEqual(msg.rawHexStr(4), '0a0b0c0d')
    })

    it('must be not writable', () => {
      const msg = new Message(Buffer.from('00', 'hex'))
      assert.strictEqual(msg.writable, false)
    })

    it('must seek forward', () => {
      const msg = new Message(Buffer.from('ff01000000', 'hex'))
      msg.seek(1)
      assert.strictEqual(msg.int32(), 1)
    })

    it('must return its size', () => {
      const msg = new Message(Buffer.from('0a0b0c0d', 'hex'))
      assert.strictEqual(msg.size(), 4)
    })

    it('must read an int64 as a number and as a bigint', () => {
      const size = 6 * 1024 * 1024 * 1024
      const buff = new Message().int64(size).getBuff().subarray(4)

      assert.strictEqual(new Message(buff).int64(), size)
      assert.strictEqual(new Message(buff).read64Big(), BigInt(size))
    })

    it('must tell how many bytes are left', () => {
      const msg = new Message(Buffer.from('0a0b0c0d', 'hex'))
      assert.strictEqual(msg.remaining(), 4)
      msg.int32()
      assert.strictEqual(msg.remaining(), 0)
    })
  })
})
