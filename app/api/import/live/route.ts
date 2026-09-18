import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { clearXCredentials, getSessionStatus, saveXCredentials } from '@/lib/x-credentials'
import { stopScheduler } from '@/lib/x-sync'

/** GET — session status without exposing cookies */
export async function GET() {
  try {
    const [lastSync, status] = await Promise.all([
      prisma.setting.findUnique({ where: { key: 'x_last_sync' } }),
      getSessionStatus(),
    ])

    return NextResponse.json({
      status,
      connected: status === 'ok',
      lastSync: lastSync?.value ?? null,
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load session' },
      { status: 500 },
    )
  }
}

/** POST — optional encrypted cookie save (UI uses Playwright; this keeps the old API working) */
export async function POST(request: NextRequest) {
  let body: { authToken?: string; ct0?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const trimmedAuth = body.authToken?.trim()
  const trimmedCt0 = body.ct0?.trim()
  if (!trimmedAuth || !trimmedCt0) {
    return NextResponse.json({ error: 'Both auth_token and ct0 are required' }, { status: 400 })
  }

  try {
    await saveXCredentials({ authToken: trimmedAuth, ct0: trimmedCt0 })
    return NextResponse.json({ saved: true, status: 'ok' })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to save session' },
      { status: 500 },
    )
  }
}

/** DELETE — drop stored X cookies */
export async function DELETE() {
  try {
    await clearXCredentials()
    stopScheduler()
    return NextResponse.json({ deleted: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to disconnect' },
      { status: 500 },
    )
  }
}
