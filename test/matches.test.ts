import assert from 'assert'
import matches from '../src/share/matches'

describe('matches', () => {
  it('matches different words with different case', () => {
    assert.strictEqual(matches('looking for AnY word that match', 'aNy match'), true)
  })

  it('does not match any word', () => {
    assert.strictEqual(matches('looking for no word that match', 'any'), false)
  })

  it('matches a string that not contains a term with minus', () => {
    assert.strictEqual(matches('looking for any word that match', 'looking -otherword'), true)
  })

  it('does not match a string when query contains an exclude', () => {
    assert.strictEqual(matches('looking for any word that match', 'looking -any'), false)
  })
})
