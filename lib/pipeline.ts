import prisma from '@/lib/db'
import { AIClient, resolveAIClient } from '@/lib/ai-client'
import { getActiveModel, getProvider } from '@/lib/settings'
import {
  seedDefaultCategories,
  categorizeBatch,
  categorizeAll,
  mapBookmarkForCategorization,
  writeCategoryResults,
  BOOKMARK_SELECT,
} from '@/lib/categorizer'
import {
  analyzeItem,
  runWithConcurrency,
  enrichBatchSemanticTags,
  BookmarkForEnrichment,
} from '@/lib/vision-analyzer'
import { backfillEntities } from '@/lib/rawjson-extractor'
import { rebuildFts } from '@/lib/fts'

export type PipelineMode = 'new' | 'force' | 'recategorizeOnly'
export type PipelineStage = 'vision' | 'entities' | 'enrichment' | 'categorize' | 'parallel'

export interface PipelineCounts {
  visionTagged: number
  entitiesExtracted: number
  enriched: number
  categorized: number
}

export interface PipelineProgress {
  stage: PipelineStage | null
  done: number
  total: number
  stageCounts: PipelineCounts
  lastError: string | null
}

const PIPELINE_WORKERS = 5
const CAT_BATCH_SIZE = 25

export interface RunPipelineOptions {
  mode?: PipelineMode
  bookmarkIds?: string[]
  shouldAbort?: () => boolean
  onProgress?: (progress: PipelineProgress) => void
}

export async function runPipeline(options: RunPipelineOptions = {}): Promise<PipelineProgress> {
  const mode = options.mode ?? 'new'
  const bookmarkIds = options.bookmarkIds ?? []
  const shouldAbort = options.shouldAbort ?? (() => false)

  const counts: PipelineCounts = {
    visionTagged: 0,
    entitiesExtracted: 0,
    enriched: 0,
    categorized: 0,
  }

  let progress: PipelineProgress = {
    stage: 'entities',
    done: 0,
    total: 0,
    stageCounts: { ...counts },
    lastError: null,
  }

  const emit = (update: Partial<PipelineProgress>) => {
    progress = { ...progress, ...update, stageCounts: { ...counts } }
    options.onProgress?.(progress)
  }

  if (mode === 'recategorizeOnly') {
    await seedDefaultCategories()
    const total = bookmarkIds.length > 0
      ? bookmarkIds.length
      : await prisma.bookmark.count()
    emit({ stage: 'categorize', total, done: 0 })
    await categorizeAll(
      bookmarkIds,
      (done, tot) => {
        counts.categorized = done
        emit({ stage: 'categorize', done, total: tot })
      },
      bookmarkIds.length === 0,
      shouldAbort,
    )
    if (!shouldAbort()) {
      await rebuildFts().catch((err) => console.error('FTS rebuild error:', err))
    }
    emit({ stage: null })
    return progress
  }

  const provider = await getProvider()
  const keyName = provider === 'openai' ? 'openaiApiKey' : 'anthropicApiKey'
  const dbApiKey =
    (await prisma.setting.findUnique({ where: { key: keyName } }))?.value?.trim() || ''

  let client: AIClient | null = null
  try {
    client = await resolveAIClient({ dbKey: dbApiKey })
  } catch {
    console.warn('No SDK client available — will rely on CLI path')
  }

  await seedDefaultCategories()

  if (mode === 'force') {
    await prisma.mediaItem.updateMany({ where: { imageTags: '{}' }, data: { imageTags: null } })
    await prisma.bookmark.updateMany({ where: { semanticTags: '[]' }, data: { semanticTags: null } })
  }

  if (!shouldAbort()) {
    emit({ stage: 'entities' })
    counts.entitiesExtracted = await backfillEntities((n) => {
      counts.entitiesExtracted = n
      emit({ stage: 'entities' })
    }, shouldAbort).catch((err) => {
      console.error('Entity extraction error:', err)
      return counts.entitiesExtracted
    })
    emit({ stage: 'entities' })
  }

  if (shouldAbort()) return progress

  let bookmarkIdsToProcess: string[]
  if (bookmarkIds.length > 0) {
    bookmarkIdsToProcess = bookmarkIds
  } else if (mode === 'force') {
    const all = await prisma.bookmark.findMany({ select: { id: true }, orderBy: { id: 'asc' } })
    bookmarkIdsToProcess = all.map((b) => b.id)
  } else {
    const unprocessed = await prisma.bookmark.findMany({
      where: { enrichedAt: null },
      select: { id: true },
      orderBy: { id: 'asc' },
    })
    bookmarkIdsToProcess = unprocessed.map((b) => b.id)
  }

  const runTotal = bookmarkIdsToProcess.length
  emit({ stage: 'parallel', done: 0, total: runTotal })

  const dbCategories = await prisma.category.findMany({
    select: { slug: true, name: true, description: true },
  })
  const allSlugs = dbCategories.map((c) => c.slug)
  const categoryDescriptions = Object.fromEntries(
    dbCategories.map((c) => [c.slug, c.description?.trim() || c.name]),
  )
  const model = await getActiveModel()

  const catPending: string[] = []
  let catFlushing = false

  async function drainCategorizeQueue(final = false): Promise<void> {
    if (final) {
      while (catFlushing) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50))
      }
    } else if (catFlushing || catPending.length < CAT_BATCH_SIZE) {
      return
    }

    catFlushing = true
    try {
      while (catPending.length > 0) {
        if (!final && catPending.length < CAT_BATCH_SIZE) break
        const ids = catPending.splice(0, CAT_BATCH_SIZE)
        if (ids.length === 0) break
        const rows = await prisma.bookmark.findMany({
          where: { id: { in: ids } },
          select: BOOKMARK_SELECT,
        })
        const batch = rows.map(mapBookmarkForCategorization)
        try {
          const results = await categorizeBatch(batch, client, categoryDescriptions, allSlugs)
          await writeCategoryResults(results)
          counts.categorized += ids.length
          emit({})
        } catch (catErr) {
          console.error('[parallel] categorize batch error:', catErr)
        }
      }
    } finally {
      catFlushing = false
    }
  }

  let processedCount = 0

  async function processBookmark(bookmarkId: string): Promise<void> {
    if (shouldAbort()) return

    const bm = await prisma.bookmark.findUnique({
      where: { id: bookmarkId },
      select: {
        id: true,
        text: true,
        semanticTags: true,
        entities: true,
        mediaItems: {
          where: { type: { in: ['photo', 'gif', 'video'] } },
          select: { id: true, url: true, thumbnailUrl: true, type: true, imageTags: true },
        },
      },
    })
    if (!bm) return

    let anyVisionRan = false
    for (const media of bm.mediaItems) {
      if (shouldAbort()) return
      if (media.imageTags !== null) continue
      try {
        await analyzeItem(
          { id: media.id, url: media.url, thumbnailUrl: media.thumbnailUrl, type: media.type },
          client,
          model,
        )
        anyVisionRan = true
        counts.visionTagged++
        emit({})
      } catch (err) {
        console.warn('[parallel] vision failed for', media.id, err instanceof Error ? err.message : err)
      }
    }

    if (!bm.semanticTags) {
      const imageTags = anyVisionRan
        ? (
            await prisma.mediaItem.findMany({
              where: { bookmarkId: bm.id, type: { in: ['photo', 'gif', 'video'] } },
              select: { imageTags: true },
            })
          )
            .map((m) => m.imageTags)
            .filter((t): t is string => t !== null && t !== '' && t !== '{}')
        : bm.mediaItems
            .map((m) => m.imageTags)
            .filter((t): t is string => t !== null && t !== '' && t !== '{}')

      if (imageTags.length === 0 && bm.text.length < 20) {
        await prisma.bookmark.update({ where: { id: bm.id }, data: { semanticTags: '[]' } })
      } else {
        let entities: BookmarkForEnrichment['entities'] = undefined
        if (bm.entities) {
          try {
            entities = JSON.parse(bm.entities) as BookmarkForEnrichment['entities']
          } catch { /* ignore */ }
        }
        try {
          const results = await enrichBatchSemanticTags(
            [{ id: bm.id, text: bm.text, imageTags, entities }],
            client,
          )
          const result = results[0]
          if (result?.tags.length) {
            await prisma.bookmark.update({
              where: { id: bm.id },
              data: {
                semanticTags: JSON.stringify(result.tags),
                enrichmentMeta: JSON.stringify({
                  sentiment: result.sentiment,
                  people: result.people,
                  companies: result.companies,
                }),
              },
            })
            counts.enriched++
            emit({})
          }
        } catch (err) {
          console.warn('[parallel] enrichment failed for', bm.id, err instanceof Error ? err.message : err)
        }
      }
    }

    catPending.push(bm.id)
    processedCount++
    emit({ done: processedCount })
    await drainCategorizeQueue()
  }

  const tasks = bookmarkIdsToProcess.map((id) => () => processBookmark(id))
  try {
    await runWithConcurrency(tasks, PIPELINE_WORKERS)
  } finally {
    await drainCategorizeQueue(true)
  }

  if (!shouldAbort()) {
    await rebuildFts().catch((err) => console.error('FTS rebuild error:', err))
  }

  emit({ stage: null, done: runTotal, total: runTotal })
  return progress
}
