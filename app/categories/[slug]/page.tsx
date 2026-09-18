'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, Download, ArrowLeft, Loader2 } from 'lucide-react'
import BookmarkCard from '@/components/bookmark-card'
import type { BookmarkWithMedia, Category } from '@/lib/types'

const PAGE_SIZE = 24

interface CategoryPageData {
  category: Category
  bookmarks: BookmarkWithMedia[]
  total: number
}

function Pagination({ page, total, limit, onChange }: {
  page: number
  total: number
  limit: number
  onChange: (p: number) => void
}) {
  const totalPages = Math.ceil(total / limit)
  if (totalPages <= 1) return null

  return (
    <div className="flex items-center justify-center gap-3 mt-8">
      <button
        onClick={() => onChange(page - 1)}
        disabled={page <= 1}
        className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        <ChevronLeft size={16} />
        Previous
      </button>
      <span className="text-sm text-zinc-500">
        Page {page} of {totalPages}
      </span>
      <button
        onClick={() => onChange(page + 1)}
        disabled={page >= totalPages}
        className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Next
        <ChevronRight size={16} />
      </button>
    </div>
  )
}

export default function CategoryPage() {
  const { slug } = useParams<{ slug: string }>()
  const router = useRouter()
  const [data, setData] = useState<CategoryPageData | null>(null)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')

  const fetchData = useCallback(async (p: number) => {
    setLoading(true)
    try {
      const [catRes, bookmarksRes] = await Promise.all([
        fetch(`/api/categories/${slug}`),
        fetch(`/api/bookmarks?category=${slug}&page=${p}&limit=${PAGE_SIZE}`),
      ])

      if (!catRes.ok) {
        router.push('/categories')
        return
      }

      const catData = await catRes.json()
      const bmData = await bookmarksRes.json()

      setData({
        category: catData.category,
        bookmarks: bmData.bookmarks ?? [],
        total: bmData.total ?? 0,
      })
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }, [slug, router])

  useEffect(() => {
    fetchData(page)
  }, [fetchData, page])

  async function handleExport() {
    if (exporting) return
    setExporting(true)
    setExportError('')
    try {
      const res = await fetch(`/api/export?type=zip&category=${encodeURIComponent(slug)}`)
      const contentType = res.headers.get('content-type') ?? ''
      if (!res.ok || contentType.includes('application/json')) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? 'Export failed')
      }

      const blob = await res.blob()
      const filename =
        res.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] ??
        `bookmarks-${slug}.zip`
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  if (loading && !data) {
    return (
      <div className="p-8 max-w-7xl mx-auto">
        <div className="h-8 w-48 bg-zinc-800 rounded animate-pulse mb-4" />
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-xl h-48 animate-pulse" />
          ))}
        </div>
      </div>
    )
  }

  const category = data?.category
  const bookmarks = data?.bookmarks ?? []
  const total = data?.total ?? 0

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <button
        onClick={() => router.push('/categories')}
        disabled={exporting}
        className="flex items-center gap-2 text-sm text-zinc-500 hover:text-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors mb-6"
      >
        <ArrowLeft size={14} />
        All Categories
      </button>

      {category && (
        <div className="flex items-start justify-between gap-4 mb-8">
          <div className="flex items-center gap-3">
            <div
              className="w-4 h-4 rounded-full shrink-0"
              style={{ backgroundColor: category.color }}
            />
            <div>
              <h1 className="text-2xl font-bold text-zinc-100">{category.name}</h1>
              {category.description && (
                <p className="text-zinc-400 text-sm mt-0.5">{category.description}</p>
              )}
              <p className="text-zinc-500 text-sm mt-1">{total.toLocaleString()} bookmark{total !== 1 ? 's' : ''}</p>
            </div>
          </div>
          <button
            onClick={() => void handleExport()}
            disabled={exporting}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 disabled:opacity-60 disabled:cursor-not-allowed text-zinc-300 text-sm font-medium transition-colors shrink-0"
          >
            {exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
            {exporting ? 'Exporting…' : 'Export ZIP'}
          </button>
        </div>
      )}

      {exportError && (
        <p className="mb-6 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          {exportError}
        </p>
      )}

      {loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-xl h-48 animate-pulse" />
          ))}
        </div>
      )}

      {!loading && bookmarks.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <p className="text-xl font-semibold text-zinc-400">No bookmarks in this category</p>
        </div>
      )}

      {!loading && bookmarks.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {bookmarks.map((bookmark) => (
            <BookmarkCard key={bookmark.id} bookmark={bookmark} />
          ))}
        </div>
      )}

      <Pagination page={page} total={total} limit={PAGE_SIZE} onChange={exporting ? () => {} : setPage} />

      {exporting && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-zinc-950/80 backdrop-blur-sm"
          role="status"
          aria-live="polite"
        >
          <div className="mx-4 w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900 px-6 py-7 text-center shadow-2xl shadow-black/50">
            <Loader2 size={28} className="mx-auto mb-4 animate-spin text-indigo-400" />
            <p className="text-base font-semibold text-zinc-100">Exporting ZIP</p>
            <p className="mt-1.5 text-sm text-zinc-500">
              Packing {total.toLocaleString()} bookmark{total !== 1 ? 's' : ''} and media.
              Stay on this page — the download starts when it is ready.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
