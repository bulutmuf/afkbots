'use strict'

const crypto = require('node:crypto')

const ADJECTIVES = Object.freeze([
  'dark', 'silent', 'swift', 'iron', 'frost', 'crimson', 'solar', 'night',
  'wild', 'royal', 'storm', 'lunar', 'rapid', 'golden', 'shadow', 'bright',
  'calm', 'bold', 'mist', 'nova', 'amber', 'arctic', 'azure', 'brave',
  'clever', 'cosmic', 'dawn', 'dusky', 'ember', 'epic', 'fierce', 'flame',
  'glossy', 'grand', 'hidden', 'icy', 'jade', 'keen', 'lucky', 'magic',
  'mighty', 'neon', 'noble', 'polar', 'prime', 'quick', 'scarlet', 'sharp',
  'silver', 'sky', 'smoky', 'sonic', 'stellar', 'sunny', 'turbo', 'velvet',
  'vivid', 'young', 'zen', 'alpha'
])

const ANIMALS = Object.freeze([
  'lion', 'wolf', 'fox', 'bear', 'hawk', 'cobra', 'raven', 'lynx',
  'tiger', 'panda', 'shark', 'eagle', 'viper', 'falcon', 'otter', 'owl',
  'badger', 'bison', 'boar', 'bull', 'cougar', 'crow', 'deer', 'drake',
  'gecko', 'heron', 'horse', 'hound', 'ibis', 'jaguar', 'koala', 'lemur',
  'mamba', 'moose', 'orca', 'puma', 'ram', 'rhino', 'rook', 'seal',
  'stork', 'swan', 'yak', 'zebra', 'finch', 'moth', 'newt', 'wren'
])

function capitalize (value) {
  return `${value[0].toUpperCase()}${value.slice(1)}`
}

function applyCasePattern (first, second, pattern) {
  return [
    `${capitalize(first)}${capitalize(second)}`,
    `${first}${second}`,
    `${capitalize(first)}${second}`,
    `${first}${capitalize(second)}`
  ][pattern]
}

function randomDigits () {
  const length = crypto.randomInt(1, 4)
  const minimum = length === 1 ? 1 : 10 ** (length - 1)
  const maximum = 10 ** length
  return String(crypto.randomInt(minimum, maximum))
}

function generateUsername (exists, maxAttempts = 10000) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const digits = randomDigits()
    const maximumWordsLength = 16 - digits.length
    const eligiblePairs = []

    for (const adjective of ADJECTIVES) {
      for (const animal of ANIMALS) {
        if (adjective.length + animal.length <= maximumWordsLength) {
          eligiblePairs.push([adjective, animal])
        }
      }
    }

    const [first, second] = eligiblePairs[crypto.randomInt(0, eligiblePairs.length)]
    const words = applyCasePattern(first, second, crypto.randomInt(0, 4))
    const username = `${words}${digits}`
    if (!exists(username)) return username
  }

  throw new Error('Could not generate a unique Minecraft username')
}

function createAccountIdentity (exists) {
  const username = generateUsername(exists)
  return {
    username,
    password: `Zx_${crypto.randomBytes(12).toString('base64url')}`,
    email: `${username.toLowerCase()}@gmail.com`
  }
}

module.exports = { generateUsername, createAccountIdentity }
