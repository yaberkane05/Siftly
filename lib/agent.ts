import prisma from '@/lib/db'
import { ftsSearch } from '@/lib/fts'
import { extractKeywords } from '@/lib/search-utils'
import { getSessionStatus } from '@/lib/x-credentials'
import { syncBookmarks, type SyncTrigger } from '@/lib/x-sync'
import { runPipeline } from '@/lib/pipeline'

const JUNK_TWEET = /^https?:\/\//i

export async function getStatus() {
  const [total, unenriched, lastSync, cursor, lastRun, session] = await Promise.all([
    prisma.bookmark.count(),
    prisma.bookmark.count({ where: { enrichedAt: null } }),
    prisma.setting.findUnique({ where: { key: 'x_last_sync' } }),
    prisma.setting.findUnique({ where: { key: 'x_sync_cursor' } }),
    prisma.syncRun.findFirst({ orderBy: { startedAt: 'desc' } }),
    getSessionStatus(),
  ])

  return {
    totalBookmarks: total,
    unprocessed: unenriched,
    lastSync: lastSync?.value ?? null,
    lastTweetId: cursor?.value ?? lastRun?.lastTweetId ?? null,
    session,
    lastRun: lastRun
      ? {
          id: lastRun.id,
          trigger: lastRun.trigger,
          status: lastRun.status,
          imported: lastRun.imported,
          skipped: lastRun.skipped,
          startedAt: lastRun.startedAt.toISOString(),
          finishedAt: lastRun.finishedAt?.toISOString() ?? null,
          errorMessage: lastRun.errorMessage,
        }
      : null,
  }
}

export async function listRecent(opts: { hours?: number; limit?: number } = {}) {
  const hours = Math.min(Math.max(opts.hours ?? 48, 1), 24 * 30)
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 40)
  const since = new Date(Date.now() - hours * 60 * 60 * 1000)

  const bookmarks = await prisma.bookmark.findMany({
    where: {
      importedAt: { gte: since },
      NOT: { tweetId: { startsWith: 'http' } },
    },
    orderBy: [{ importedAt: 'desc' }, { tweetCreatedAt: 'desc' }],
    take: limit,
    include: {
      mediaItems: { select: { type: true, url: true, thumbnailUrl: true } },
      categories: {
        include: { category: { select: { name: true, slug: true } } },
        orderBy: { confidence: 'desc' },
      },
    },
  })

  return {
    hours,
    count: bookmarks.length,
    bookmarks: bookmarks.filter((b) => !JUNK_TWEET.test(b.tweetId)).map(formatAgentBookmark),
  }
}

export async function searchBookmarks(query: string, limit = 20) {
  const keywords = extractKeywords(query)
  if (keywords.length === 0) return { query, count: 0, bookmarks: [] }

  const ftsIds = await ftsSearch(keywords)
  const take = Math.min(Math.max(limit, 1), 40)

  const where = ftsIds.length > 0
    ? { id: { in: ftsIds } }
    : {
        OR: keywords.flatMap((kw) => [
          { text: { contains: kw } },
          { semanticTags: { contains: kw } },
          { entities: { contains: kw } },
        ]),
      }

  const bookmarks = await prisma.bookmark.findMany({
    where,
    take,
    include: {
      mediaItems: { select: { type: true, url: true, thumbnailUrl: true } },
      categories: {
        include: { category: { select: { name: true, slug: true } } },
        orderBy: { confidence: 'desc' },
      },
    },
  })

  return {
    query,
    count: bookmarks.length,
    bookmarks: bookmarks.map(formatAgentBookmark),
  }
}

export async function syncFromX(trigger: SyncTrigger = 'mcp') {
  const result = await syncBookmarks(trigger, { harvestIfNeeded: true })
  let processed = 0
  if (result.imported > 0) {
    const progress = await runPipeline({ mode: 'new' })
    processed = progress.done
  }
  return { ...result, processed }
}

export async function listSyncRuns(limit = 8) {
  const runs = await prisma.syncRun.findMany({
    orderBy: { startedAt: 'desc' },
    take: Math.min(limit, 20),
  })
  return runs.map((r) => ({
    id: r.id,
    trigger: r.trigger,
    status: r.status,
    imported: r.imported,
    skipped: r.skipped,
    lastTweetId: r.lastTweetId,
    errorMessage: r.errorMessage,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  }))
}

function formatAgentBookmark(b: {
  id: string
  tweetId: string
  text: string
  authorHandle: string
  authorName: string
  tweetCreatedAt: Date | null
  importedAt: Date
  mediaItems: { type: string; url: string; thumbnailUrl: string | null }[]
  categories: { confidence: number; category: { name: string; slug: string } }[]
}) {
  return {
    id: b.id,
    tweetId: b.tweetId,
    url: `https://x.com/i/status/${b.tweetId}`,
    text: b.text,
    authorHandle: b.authorHandle,
    authorName: b.authorName,
    tweetCreatedAt: b.tweetCreatedAt?.toISOString() ?? null,
    importedAt: b.importedAt.toISOString(),
    media: b.mediaItems.map((m) => ({ type: m.type, url: m.url, thumbnailUrl: m.thumbnailUrl })),
    categories: b.categories.map((c) => ({
      name: c.category.name,
      slug: c.category.slug,
      confidence: c.confidence,
    })),
  }
}
