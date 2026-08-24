'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { generateUsername } = require('../src/username-generator')

test('generates unique Minecraft-safe names with one to three digits', () => {
  const names = new Set()
  const digitLengths = new Set()

  for (let index = 0; index < 10000; index += 1) {
    const username = generateUsername(value => names.has(value.toLowerCase()))
    assert.match(username, /^[A-Za-z]+[0-9]{1,3}$/u)
    assert.ok(username.length <= 16)
    assert.equal(names.has(username.toLowerCase()), false)
    names.add(username.toLowerCase())
    digitLengths.add(username.match(/[0-9]+$/u)[0].length)
  }

  assert.deepEqual([...digitLengths].sort(), [1, 2, 3])
})
