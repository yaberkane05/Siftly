import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import path from 'path'

const PREFIX = 'enc:v1:'
const KEY_DIR = path.join(homedir(), 'AppData', 'Roaming', 'Siftly')
const KEY_PATH = path.join(KEY_DIR, 'master.key')

function loadMasterKey(): Buffer {
  if (existsSync(KEY_PATH)) {
    const raw = readFileSync(KEY_PATH)
    if (raw.length === 32) return raw
  }
  mkdirSync(KEY_DIR, { recursive: true })
  const key = randomBytes(32)
  writeFileSync(KEY_PATH, key, { mode: 0o600 })
  return key
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX)
}

export function encryptSecret(plaintext: string): string {
  const key = loadMasterKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`
}

export function decryptSecret(value: string): string {
  if (!isEncrypted(value)) return value
  const payload = value.slice(PREFIX.length)
  const [ivB64, tagB64, dataB64] = payload.split(':')
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Corrupt encrypted secret')
  }
  const key = loadMasterKey()
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}
