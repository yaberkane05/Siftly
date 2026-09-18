import prisma from '@/lib/db'
import { fetchPage, parsePage, importTweets, TwitterAuthError } from '@/lib/twitter-api'
import { getXCredentials, saveCt0, setSessionStatus } from '@/lib/x-credentials'
import { harvestXSession } from '@/lib/x-session'

const CONSECUTIVE_KNOWN = 5
const MAX_PAGES = 50

export type SyncTrigger = 'json' | 'x-sync' | 'mcp'

export interface SyncResult {
  imported: number
  skipped: number
  lastTweetId: string | null
}

let syncing = false

export function isSyncing() {
  return syncing
}

export async function recordSyncRun(params: {
  trigger: SyncTrigger
  status: 'running' | 'done' | 'error'
  imported?: number
  skipped?: number
  lastTweetId?: string | null
  errorMessage?: string | null
  id?: string
}): Promise<string> {
  if (params.id) {
    await prisma.syncRun.update({
      where: { id: params.id },
      data: {
        status: params.status,
        imported: params.imported ?? 0,
        skipped: params.skipped ?? 0,
        lastTweetId: params.lastTweetId ?? undefined,
        errorMessage: params.errorMessage ?? undefined,
        finishedAt: params.status === 'running' ? null : new Date(),
      },
    })
    return params.id
  }

  const created = await prisma.syncRun.create({
    data: {
      trigger: params.trigger,
      status: params.status,
      imported: params.imported ?? 0,
      skipped: params.skipped ?? 0,
      lastTweetId: params.lastTweetId ?? undefined,
      errorMessage: params.errorMessage ?? undefined,
      finishedAt: params.status === 'running' ? null : new Date(),
    },
  })
  return created.id
}

async function fetchAndImport(authToken: string, ct0: string): Promise<SyncResult> {
  let imported = 0
  let skipped = 0
  let cursor: string | undefined
  let lastTweetId: string | null = null
  let consecutiveKnown = 0
  let currentCt0 = ct0

  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, csrf } = await fetchPage(authToken, currentCt0, cursor)
    if (csrf && csrf !== currentCt0) {
      currentCt0 = csrf
      await saveCt0(csrf)
    }

    const { tweets, nextCursor } = parsePage(data)

    if (page === 0 && tweets.length === 0 && !nextCursor) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hasTimeline = (data as any)?.data?.bookmark_timeline_v2?.timeline
      if (!hasTimeline) {
        throw new Error('Twitter API response format has changed. The sync feature may need updating.')
      }
    }

    if (page === 0 && tweets[0]?.rest_id) {
      lastTweetId = tweets[0].rest_id
    }

    const pageImported: typeof tweets = []
    for (const tweet of tweets) {
      if (!tweet.rest_id) continue
      const exists = await prisma.bookmark.findUnique({
        where: { tweetId: tweet.rest_id },
        select: { id: true },
      })
      if (exists) {
        skipped++
        consecutiveKnown++
        if (consecutiveKnown >= CONSECUTIVE_KNOWN) break
        continue
      }
      consecutiveKnown = 0
      pageImported.push(tweet)
    }

    if (pageImported.length > 0) {
      const result = await importTweets(pageImported)
      imported += result.imported
      skipped += result.skipped
    }

    if (consecutiveKnown >= CONSECUTIVE_KNOWN) break
    if (!nextCursor || tweets.length === 0) break
    cursor = nextCursor
  }

  if (lastTweetId) {
    await prisma.setting.upsert({
      where: { key: 'x_sync_cursor' },
      update: { value: lastTweetId },
      create: { key: 'x_sync_cursor', value: lastTweetId },
    })
  }

  if (imported > 0 || skipped > 0) {
    const now = new Date().toISOString()
    await prisma.setting.upsert({
      where: { key: 'x_last_sync' },
      update: { value: now },
      create: { key: 'x_last_sync', value: now },
    })
  }

  await setSessionStatus('ok')
  return { imported, skipped, lastTweetId }
}

export async function syncBookmarks(
  trigger: SyncTrigger = 'x-sync',
  opts: { harvestIfNeeded?: boolean } = {},
): Promise<SyncResult> {
  if (syncing) throw new Error('A sync is already in progress')
  syncing = true

  const runId = await recordSyncRun({ trigger, status: 'running' })

  try {
    let creds = await getXCredentials()
    const harvestIfNeeded = opts.harvestIfNeeded !== false

    if (!creds) {
      if (!harvestIfNeeded) throw new Error('X session not connected')
      creds = await harvestXSession()
    }

    let result: SyncResult
    try {
      result = await fetchAndImport(creds.authToken, creds.ct0)
    } catch (err) {
      if (err instanceof TwitterAuthError && harvestIfNeeded) {
        await setSessionStatus('expired')
        creds = await harvestXSession()
        result = await fetchAndImport(creds.authToken, creds.ct0)
      } else {
        if (err instanceof TwitterAuthError) await setSessionStatus('expired')
        throw err
      }
    }

    await recordSyncRun({
      id: runId,
      trigger,
      status: 'done',
      imported: result.imported,
      skipped: result.skipped,
      lastTweetId: result.lastTweetId,
    })
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await recordSyncRun({
      id: runId,
      trigger,
      status: 'error',
      errorMessage: message.slice(0, 500),
    })
    throw err
  } finally {
    syncing = false
  }
}

// ── Scheduler (kept for existing API, not started by the new Import UI) ────────

type SyncInterval = '1h' | '4h' | '8h' | '24h'

const INTERVAL_MS: Record<SyncInterval, number> = {
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '8h': 8 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null

export async function startScheduler() {
  stopScheduler()

  const intervalSetting = await prisma.setting.findUnique({ where: { key: 'x_sync_interval' } })
  if (!intervalSetting?.value || intervalSetting.value === 'off') return

  const interval = intervalSetting.value as SyncInterval
  const ms = INTERVAL_MS[interval]
  if (!ms) {
    console.warn(`[x-sync] Invalid sync interval "${intervalSetting.value}" in database, not starting scheduler`)
    return
  }

  schedulerTimer = setInterval(() => void runScheduledSync(), ms)
  console.log(`[x-sync] Scheduler started: every ${interval}`)
}

export function stopScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer)
    schedulerTimer = null
    console.log('[x-sync] Scheduler stopped')
  }
}

async function runScheduledSync() {
  if (syncing) return
  try {
    console.log(`[x-sync] Running scheduled sync at ${new Date().toISOString()}`)
    const result = await syncBookmarks('x-sync', { harvestIfNeeded: false })
    console.log(`[x-sync] Sync complete: ${result.imported} imported, ${result.skipped} skipped`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[x-sync] Scheduled sync failed:', message)
    if (message.includes('401') || message.includes('403')) {
      console.error('[x-sync] Auth error detected, stopping scheduler')
      stopScheduler()
    }
  }
}

export function isSchedulerRunning() {
  return schedulerTimer !== null
}
