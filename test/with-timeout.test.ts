import assert from 'assert'
import withTimeout from '../src/utils/with-timeout'

describe('withTimeout', () => {
  it('resolves with the value when the promise is in time', async () => {
    const value = await withTimeout(Promise.resolve('done'), 1000, new Error('too late'))

    assert.strictEqual(value, 'done')
  })

  it('rejects with the given error when it is not', async () => {
    const never = new Promise<never>(() => {})

    await assert.rejects(withTimeout(never, 10, new Error('too late')), { message: 'too late' })
  })

  it('keeps the rejection of the promise it wraps', async () => {
    const failing = Promise.reject(new Error('failed on its own'))

    await assert.rejects(withTimeout(failing, 1000, new Error('too late')), {
      message: 'failed on its own'
    })
  })
})
