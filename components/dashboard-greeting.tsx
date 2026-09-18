'use client'

import { useEffect, useState } from 'react'

function greetingFor(date: Date): string {
  const hour = date.getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

export default function DashboardGreeting({ bookmarkCount }: { bookmarkCount: number }) {
  const [now, setNow] = useState<Date | null>(null)

  useEffect(() => {
    setNow(new Date())
  }, [])

  const dateLabel = now
    ? now.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      })
    : '\u00a0'
  const greeting = now ? greetingFor(now) : 'Welcome'

  return (
    <div>
      <p className="text-sm text-zinc-500 mb-1 uppercase tracking-widest font-medium min-h-[1.25rem]">
        {dateLabel}
      </p>
      <h1 className="text-3xl md:text-4xl font-bold text-zinc-100">
        {greeting} <span className="text-indigo-400">&#128075;</span>
      </h1>
      <p className="text-zinc-400 mt-1.5">
        You have{' '}
        <span className="text-zinc-100 font-semibold">{bookmarkCount.toLocaleString('en-US')}</span>{' '}
        tweets saved and ready to explore.
      </p>
    </div>
  )
}
