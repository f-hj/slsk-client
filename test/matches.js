/* eslint-env mocha */

const assert = require('assert')
const matches = require('../lib/share/matches.js')

describe('matches', () => {
  it('matches different words with different case', () => {
    assert.equal(matches('looking for AnY word that match', 'aNy match'), true)
  })

  it('does not match any word', () => {
    assert.equal(matches('looking for no word that match', 'any'), false)
  })

  it('matches a string that not contains a term with minus', () => {
    assert.equal(matches('looking for any word that match', 'looking -otherword'), true)
  })

  it('does not match a string when query contains an exclude', () => {
    assert.equal(matches('looking for any word that match', 'looking -any'), false)
  })
})
