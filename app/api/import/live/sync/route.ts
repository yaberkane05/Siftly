import { NextResponse } from 'next/server'
import { syncBookmarks, isSyncing } from '@/lib/x-sync'

export const maxDuration = 300

/** POST — incremental GraphQL bookmark sync */
export async function POST() {
  if (isSyncing()) {
    return NextResponse.json({ error: 'A sync is already in progress' }, { status: 409 })
  }

  try {
    const result = await syncBookmarks('x-sync', { harvestIfNeeded: true })
    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Sync failed'
    const status = msg.includes('already in progress') ? 409 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
