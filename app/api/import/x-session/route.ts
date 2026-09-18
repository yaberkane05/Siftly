import { NextResponse } from 'next/server'
import { harvestXSession, SessionHarvestError } from '@/lib/x-session'
import { getSessionStatus } from '@/lib/x-credentials'

export const maxDuration = 300

export async function GET() {
  const status = await getSessionStatus()
  return NextResponse.json({ status })
}

export async function POST() {
  try {
    await harvestXSession()
    return NextResponse.json({ status: 'ok' })
  } catch (err) {
    const message = err instanceof SessionHarvestError
      ? err.message
      : err instanceof Error
        ? err.message
        : 'Failed to connect X session'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
