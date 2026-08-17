import assert from 'assert'
import EventEmitter from 'events'
import waitFor from '../src/utils/wait-for'

type Events = {
  answer: [value: number, from: string]
  other: [value: number]
}

describe('waitFor', () => {
  it('resolves with the arguments of the emission', async () => {
    const emitter = new EventEmitter<Events>()
    const answer = waitFor(emitter, 'answer', { timeout: 500 })

    emitter.emit('answer', 42, 'alice')

    assert.deepStrictEqual(await answer, [42, 'alice'])
  })

  it('keeps waiting until the emission matches', async () => {
    const emitter = new EventEmitter<Events>()
    const answer = waitFor(emitter, 'answer', {
      timeout: 500,
      match: (_value, from) => from === 'bob'
    })

    emitter.emit('answer', 1, 'alice')
    emitter.emit('answer', 2, 'bob')

    assert.deepStrictEqual(await answer, [2, 'bob'])
  })

  it('rejects with the given error when nothing comes', async () => {
    const emitter = new EventEmitter<Events>()

    await assert.rejects(
      waitFor(emitter, 'answer', { timeout: 20, timeoutError: new Error('too slow') }),
      { message: 'too slow' }
    )
  })

  it('leaves no listener behind', async () => {
    const emitter = new EventEmitter<Events>()

    const resolved = waitFor(emitter, 'answer', { timeout: 500 })
    assert.strictEqual(emitter.listenerCount('answer'), 1)
    emitter.emit('answer', 1, 'alice')
    await resolved
    assert.strictEqual(emitter.listenerCount('answer'), 0)

    await assert.rejects(waitFor(emitter, 'answer', { timeout: 20 }))
    assert.strictEqual(emitter.listenerCount('answer'), 0)
  })
})
