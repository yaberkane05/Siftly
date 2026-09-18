import { mkdirSync } from 'fs'
import { homedir } from 'os'
import path from 'path'
import { chromium } from 'playwright'
import { saveXCredentials, type XCredentials } from '@/lib/x-credentials'

const PROFILE_DIR = path.join(homedir(), 'AppData', 'Roaming', 'Siftly', 'browser-profile')
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

export class SessionHarvestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionHarvestError'
  }
}

export async function harvestXSession(): Promise<XCredentials> {
  mkdirSync(PROFILE_DIR, { recursive: true })

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  })

  try {
    const page = context.pages()[0] ?? await context.newPage()
    await page.goto('https://x.com/i/bookmarks', { waitUntil: 'domcontentloaded', timeout: 60_000 })

    await page.waitForFunction(
      () => {
        const path = location.pathname
        const loggedIn = document.cookie.includes('auth_token=')
        const onLogin = path.includes('/login') || path.includes('/i/flow/login')
        return loggedIn && !onLogin
      },
      { timeout: LOGIN_TIMEOUT_MS },
    )

    if (!page.url().includes('/i/bookmarks')) {
      await page.goto('https://x.com/i/bookmarks', { waitUntil: 'domcontentloaded', timeout: 60_000 })
    }

    const cookies = await context.cookies(['https://x.com', 'https://twitter.com'])
    const authToken = cookies.find((c) => c.name === 'auth_token')?.value
    const ct0 = cookies.find((c) => c.name === 'ct0')?.value

    if (!authToken || !ct0) {
      throw new SessionHarvestError('Logged in but auth_token or ct0 cookie is missing')
    }

    const creds = { authToken, ct0 }
    await saveXCredentials(creds)
    return creds
  } catch (err) {
    if (err instanceof SessionHarvestError) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new SessionHarvestError(
      message.includes('Timeout')
        ? 'Timed out waiting for X login in the browser window'
        : message,
    )
  } finally {
    await context.close()
  }
}

