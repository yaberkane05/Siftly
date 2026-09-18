import { NextResponse } from 'next/server'
import { listSyncRuns } from '@/lib/agent'

export async function GET() {
  try {
    const runs = await listSyncRuns(12)
    return NextResponse.json({ runs })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load import history' },
      { status: 500 },
    )
  }
}
