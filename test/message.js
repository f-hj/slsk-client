const assert = require('assert')

const Message = require('../lib/message.js')

describe('class Message', () => {

  describe('write', () => {

    it('correct int8', () => {
      let msg = new Message()
      assert.equal(msg.int8(1).getBuff().toString('hex'), '0100000001')
    })

    it('correct int32', () => {
      let msg = new Message()
      assert.equal(msg.int32(1).getBuff().toString('hex'), '0400000001000000')
    })

    it('correct string', () => {
      let msg = new Message()
      assert.equal(msg.str('coucou').getBuff().toString('hex'), '0a00000006000000636f75636f75')
    })

    it('correct msg', () => {
      let msg = new Message()
      assert.equal(msg.int8(1).int32(666).str('coucou').getBuff().toString('hex'), '0f000000019a02000006000000636f75636f75')
    })

  })

  describe('read', () => {

    let buff = Buffer.from('0f000000019a02000006000000636f75636f75', 'hex')
    let msg = new Message(buff)

    it('must read correct msg', () => {
      assert.equal(msg.int32(), 15)
      assert.equal(msg.int8(), 1)
      assert.equal(msg.int32(), 666)
      assert.equal(msg.str(), 'coucou')
    })

    it('must be not writable', () => {
      assert.equal(msg.write, false)
    })

  })

})
