import JSZip from 'jszip'
import prisma from '@/lib/db'

interface BookmarkRow {
  id: string
  tweetId: string
  text: string
  authorHandle: string
  authorName: string
  source: string
  tweetCreatedAt: Date | null
  importedAt: Date
  mediaItems: MediaItemRow[]
  categories: CategoryJoin[]
}

interface MediaItemRow {
  id: string
  type: string
  url: string
  thumbnailUrl: string | null
  localPath: string | null
}

interface CategoryJoin {
  category: {
    name: string
    slug: string
    color: string
  }
}

async function fetchBookmarksFull(where?: object): Promise<BookmarkRow[]> {
  return prisma.bookmark.findMany({
    where,
    include: {
      mediaItems: true,
      categories: {
        include: { category: true },
      },
    },
    orderBy: { importedAt: 'desc' },
  }) as Promise<BookmarkRow[]>
}

function formatCsvField(value: string): string {
  const escaped = value.replace(/"/g, '""')
  return `"${escaped}"`
}

function buildCsvRow(fields: string[]): string {
  return fields.map(formatCsvField).join(',')
}

async function downloadFile(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return null
    const arrayBuffer = await response.arrayBuffer()
    return Buffer.from(arrayBuffer)
  } catch {
    return null
  }
}

function urlToFilename(url: string, index: number, ext: string): string {
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split('/')
    const last = segments[segments.length - 1]
    if (last && last.includes('.')) return last
  } catch {
    // fall through
  }
  return `media_${index}${ext}`
}

function mediaExtension(type: string, url: string): string {
  if (type === 'video') return '.mp4'
  if (type === 'gif') return '.mp4'
  if (url.endsWith('.jpg') || url.endsWith('.jpeg')) return '.jpg'
  if (url.endsWith('.png')) return '.png'
  if (url.endsWith('.webp')) return '.webp'
  return '.jpg'
}

export async function exportCategoryAsZip(categorySlug: string): Promise<Buffer> {
  const category = await prisma.category.findUnique({
    where: { slug: categorySlug },
  })

  if (!category) {
    throw new Error(`Category not found: ${categorySlug}`)
  }

  const bookmarks = await fetchBookmarksFull({
    categories: {
      some: { category: { slug: categorySlug } },
    },
  })

  const zip = new JSZip()
  const mediaFolder = zip.folder('media')

  const manifestRows: string[] = [
    buildCsvRow(['tweetId', 'text', 'author', 'url', 'categories', 'date']),
  ]

  let mediaIndex = 0
  for (const bookmark of bookmarks) {
    const tweetUrl = `https://twitter.com/${bookmark.authorHandle}/status/${bookmark.tweetId}`
    const categoryNames = bookmark.categories.map((c) => c.category.name).join('; ')
    const dateStr = bookmark.tweetCreatedAt?.toISOString() ?? ''

    manifestRows.push(
      buildCsvRow([
        bookmark.tweetId,
        bookmark.text,
        bookmark.authorHandle,
        tweetUrl,
        categoryNames,
        dateStr,
      ])
    )

    for (const item of bookmark.mediaItems) {
      const ext = mediaExtension(item.type, item.url)
      const filename = urlToFilename(item.url, mediaIndex, ext)
      mediaIndex++

      const fileData = await downloadFile(item.url)
      if (fileData && mediaFolder) {
        mediaFolder.file(filename, fileData)
      }
    }
  }

  zip.file('manifest.csv', manifestRows.join('\n'))

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  return buffer
}

export async function exportAllBookmarksCsv(): Promise<string> {
  const bookmarks = await fetchBookmarksFull()

  const headers = buildCsvRow([
    'tweetId',
    'text',
    'authorHandle',
    'source',
    'categories',
    'tweetCreatedAt',
    'mediaUrls',
  ])

  const rows = bookmarks.map((bookmark) => {
    const categories = bookmark.categories.map((c) => c.category.name).join('; ')
    const mediaUrls = bookmark.mediaItems.map((m) => m.url).join('; ')
    const dateStr = bookmark.tweetCreatedAt?.toISOString() ?? ''

    return buildCsvRow([
      bookmark.tweetId,
      bookmark.text,
      bookmark.authorHandle,
      bookmark.source,
      categories,
      dateStr,
      mediaUrls,
    ])
  })

  return [headers, ...rows].join('\n')
}

export async function exportBookmarksJson(bookmarkIds?: string[]): Promise<string> {
  const where = bookmarkIds && bookmarkIds.length > 0
    ? { id: { in: bookmarkIds } }
    : undefined

  const bookmarks = await fetchBookmarksFull(where)

  const output = bookmarks.map((bookmark) => ({
    tweetId: bookmark.tweetId,
    text: bookmark.text,
    authorHandle: bookmark.authorHandle,
    authorName: bookmark.authorName,
    source: bookmark.source,
    tweetCreatedAt: bookmark.tweetCreatedAt?.toISOString() ?? null,
    importedAt: bookmark.importedAt.toISOString(),
    categories: bookmark.categories.map((c) => ({
      name: c.category.name,
      slug: c.category.slug,
      color: c.category.color,
    })),
    mediaItems: bookmark.mediaItems.map((m) => ({
      type: m.type,
      url: m.url,
      thumbnailUrl: m.thumbnailUrl,
    })),
  }))

  return JSON.stringify(output, null, 2)
}

export interface SearchExportMeta {
  query: string
  explanation?: string
  reasons?: Record<string, string>
  scores?: Record<string, number>
}

/**
 * ZIP export for AI Search results: manifest + JSON + downloaded media.
 */
export async function exportSearchResultsAsZip(
  bookmarkIds: string[],
  meta: SearchExportMeta,
): Promise<Buffer> {
  if (bookmarkIds.length === 0) {
    throw new Error('No bookmarks to export')
  }

  const bookmarks = await fetchBookmarksFull({ id: { in: bookmarkIds } })
  // Preserve AI search ranking order
  const order = new Map(bookmarkIds.map((id, i) => [id, i]))
  bookmarks.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))

  const zip = new JSZip()
  const mediaFolder = zip.folder('media')

  const rows: string[] = [
    buildCsvRow(['rank', 'tweetId', 'text', 'author', 'url', 'categories', 'aiScore', 'aiReason', 'date']),
  ]

  const jsonBookmarks: object[] = []
  let mediaIndex = 0

  for (let rank = 0; rank < bookmarks.length; rank++) {
    const bookmark = bookmarks[rank]
    const tweetUrl =
      bookmark.authorHandle && bookmark.authorHandle !== 'unknown'
        ? `https://x.com/${bookmark.authorHandle}/status/${bookmark.tweetId}`
        : `https://x.com/i/status/${bookmark.tweetId}`
    const categoryNames = bookmark.categories.map((c) => c.category.name).join('; ')
    const dateStr = bookmark.tweetCreatedAt?.toISOString() ?? ''
    const aiScore = meta.scores?.[bookmark.id]
    const aiReason = meta.reasons?.[bookmark.id] ?? ''

    rows.push(
      buildCsvRow([
        String(rank + 1),
        bookmark.tweetId,
        bookmark.text,
        bookmark.authorHandle,
        tweetUrl,
        categoryNames,
        aiScore != null ? String(aiScore) : '',
        aiReason,
        dateStr,
      ]),
    )

    const localMedia: { type: string; url: string; filename: string | null }[] = []
    for (const item of bookmark.mediaItems) {
      const ext = mediaExtension(item.type, item.url)
      const filename = `${bookmark.tweetId}_${mediaIndex}${ext}`
      mediaIndex++
      const fileData = await downloadFile(item.url)
      if (fileData && mediaFolder) {
        mediaFolder.file(filename, fileData)
        localMedia.push({ type: item.type, url: item.url, filename })
      } else {
        localMedia.push({ type: item.type, url: item.url, filename: null })
      }
    }

    jsonBookmarks.push({
      rank: rank + 1,
      tweetId: bookmark.tweetId,
      tweetUrl,
      text: bookmark.text,
      authorHandle: bookmark.authorHandle,
      authorName: bookmark.authorName,
      tweetCreatedAt: bookmark.tweetCreatedAt?.toISOString() ?? null,
      aiScore: aiScore ?? null,
      aiReason: aiReason || null,
      categories: bookmark.categories.map((c) => ({
        name: c.category.name,
        slug: c.category.slug,
      })),
      mediaItems: localMedia,
    })
  }

  zip.file('manifest.csv', rows.join('\n'))
  zip.file(
    'bookmarks.json',
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        query: meta.query,
        explanation: meta.explanation ?? null,
        count: jsonBookmarks.length,
        bookmarks: jsonBookmarks,
      },
      null,
      2,
    ),
  )

  const md: string[] = [
    `# AI Search export`,
    ``,
    `- Query: ${meta.query}`,
    `- Exported: ${new Date().toISOString()}`,
    `- Results: ${jsonBookmarks.length}`,
    meta.explanation ? `- Summary: ${meta.explanation}` : '',
    ``,
    `---`,
    ``,
  ]

  for (const b of jsonBookmarks as Array<{
    rank: number
    tweetId: string
    tweetUrl: string
    text: string
    authorHandle: string
    aiScore: number | null
    aiReason: string | null
    categories: { name: string }[]
    mediaItems: { filename: string | null; url: string }[]
  }>) {
    md.push(`## ${b.rank}. @${b.authorHandle} — ${b.tweetId}`)
    md.push(``)
    md.push(b.text.replace(/\n+/g, ' ').trim())
    md.push(``)
    md.push(`- Link: ${b.tweetUrl}`)
    if (b.aiScore != null) md.push(`- AI score: ${b.aiScore}`)
    if (b.aiReason) md.push(`- Why: ${b.aiReason}`)
    md.push(`- Categories: ${b.categories.map((c) => c.name).join(', ') || '—'}`)
    if (b.mediaItems.length > 0) {
      md.push(
        `- Media: ${b.mediaItems.map((m) => (m.filename ? `media/${m.filename}` : m.url)).join(', ')}`,
      )
    }
    md.push(``)
  }

  zip.file('index.md', md.filter((l) => l !== '').join('\n'))

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
