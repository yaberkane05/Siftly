import prisma from '@/lib/db'
import { decryptSecret, encryptSecret, isEncrypted } from '@/lib/secret-box'

export type XSessionStatus = 'ok' | 'needs_browser' | 'expired'

export interface XCredentials {
  authToken: string
  ct0: string
}

async function upsertSetting(key: string, value: string): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  })
}

export async function getSessionStatus(): Promise<XSessionStatus> {
  const status = await prisma.setting.findUnique({ where: { key: 'x_session_status' } })
  if (status?.value === 'expired') return 'expired'
  if (status?.value === 'ok') return 'ok'
  const creds = await getXCredentials()
  return creds ? 'ok' : 'needs_browser'
}

export async function setSessionStatus(status: XSessionStatus): Promise<void> {
  await upsertSetting('x_session_status', status)
}

export async function saveXCredentials(creds: XCredentials): Promise<void> {
  await Promise.all([
    upsertSetting('x_auth_token', encryptSecret(creds.authToken)),
    upsertSetting('x_ct0', encryptSecret(creds.ct0)),
    upsertSetting('x_session_status', 'ok'),
  ])
}

export async function saveCt0(ct0: string): Promise<void> {
  await upsertSetting('x_ct0', encryptSecret(ct0))
}

export async function getXCredentials(): Promise<XCredentials | null> {
  const [auth, ct0] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'x_auth_token' } }),
    prisma.setting.findUnique({ where: { key: 'x_ct0' } }),
  ])
  if (!auth?.value || !ct0?.value) return null

  try {
    let authToken = decryptSecret(auth.value)
    let csrf = decryptSecret(ct0.value)

    // Migrate leftover plaintext into encrypted storage
    if (!isEncrypted(auth.value) || !isEncrypted(ct0.value)) {
      await saveXCredentials({ authToken, ct0: csrf })
    }

    if (!authToken || !csrf) return null
    return { authToken, ct0: csrf }
  } catch {
    return null
  }
}

export async function clearXCredentials(): Promise<void> {
  await prisma.setting.deleteMany({
    where: { key: { in: ['x_auth_token', 'x_ct0', 'x_session_status'] } },
  })
}
