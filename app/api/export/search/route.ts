import { mkdir, writeFile } from 'fs/promises'
import path from 'path'
import { NextRequest, NextResponse } from 'next/server'
import { exportSearchResultsAsZip } from '@/lib/exporter'

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'search'
}

/**
 * POST /api/export/search
 * Body: { ids: string[], query: string, explanation?: string, reasons?: Record<string,string>, scores?: Record<string,number>, saveToDisk?: boolean }
 *
 * Returns a ZIP download. When saveToDisk=true (default), also writes the ZIP
 * under exports/ai-search/<timestamp>-<slug>/ in the project folder.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as {
      ids?: string[]
      query?: string
      explanation?: string
      reasons?: Record<string, string>
      scores?: Record<string, number>
      saveToDisk?: boolean
    }

    const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string') : []
    const query = typeof body.query === 'string' ? body.query.trim() : ''

    if (ids.length === 0) {
      return NextResponse.json({ error: 'ids[] is required' }, { status: 400 })
    }
    if (!query) {
      return NextResponse.json({ error: 'query is required' }, { status: 400 })
    }

    const zipBuffer = await exportSearchResultsAsZip(ids, {
      query,
      explanation: body.explanation,
      reasons: body.reasons,
      scores: body.scores,
    })

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const folderName = `${stamp}-${slugify(query)}`
    const filename = `siftly-ai-search-${slugify(query)}.zip`

    let savedPath: string | null = null
    const saveToDisk = body.saveToDisk !== false

    if (saveToDisk) {
      const outDir = path.join(process.cwd(), 'exports', 'ai-search', folderName)
      await mkdir(outDir, { recursive: true })
      const zipPath = path.join(outDir, filename)
      await writeFile(zipPath, zipBuffer)
      savedPath = zipPath
    }

    return new NextResponse(new Uint8Array(zipBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'X-Siftly-Saved-Path': savedPath ?? '',
        'X-Siftly-Export-Count': String(ids.length),
      },
    })
  } catch (err) {
    console.error('Search export error:', err)
    return NextResponse.json(
      { error: `Failed to export search results: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  }
}
