// Capture desktop / tablet / mobile screenshots of the running MinStorage app
// and write them into ./images for use in the project README.
//
// Usage:
//   cd screenshots && npm install
//   MINSTORAGE_USER=sveinn MINSTORAGE_PASS=minioadmin node capture.mjs
//
// Config via env (all optional except credentials):
//   BASE_URL          default http://127.0.0.1:7002
//   MINSTORAGE_USER   login user  (MinIO access key)
//   MINSTORAGE_PASS   login pass  (MinIO secret key)
//   OUT_DIR           default ./images
//   CHROME_PATH       path to a Chrome/Chromium binary (auto-detected if unset)
//   ENTER_FOLDER      name of a folder to open before capturing (default "screenshot stuff").
//                     Set to "" to capture the bucket root instead.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:7002'
const USER = process.env.MINSTORAGE_USER || process.env.MIN_USER || ''
const PASS = process.env.MINSTORAGE_PASS || process.env.MIN_PASS || ''
const OUT_DIR = path.resolve(__dirname, process.env.OUT_DIR || 'images')
const ENTER_FOLDER = process.env.ENTER_FOLDER ?? 'screenshot stuff'

// Viewports we capture. deviceScaleFactor 2 keeps text crisp on retina-style shots.
const TARGETS = [
  { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: 'tablet', width: 834, height: 1112, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: 'mobile', width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
]

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  // Prefer a puppeteer-managed Chrome from the user cache (newest version).
  const base = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome')
  if (fs.existsSync(base)) {
    const dirs = fs.readdirSync(base).filter((d) => d.startsWith('linux-')).sort().reverse()
    for (const d of dirs) {
      const p = path.join(base, d, 'chrome-linux64', 'chrome')
      if (fs.existsSync(p)) return p
    }
  }
  for (const p of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(p)) return p
  }
  throw new Error('No Chrome/Chromium found. Set CHROME_PATH to a browser binary.')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function login(page) {
  await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 30000 })
  // The login form has exactly two inputs: User then Password.
  await page.waitForSelector('form input', { timeout: 15000 })
  const inputs = await page.$$('form input')
  if (inputs.length < 2) throw new Error('Login form inputs not found')
  await inputs[0].click({ clickCount: 3 })
  await inputs[0].type(USER, { delay: 10 })
  await inputs[1].click({ clickCount: 3 })
  await inputs[1].type(PASS, { delay: 10 })
  await page.click('form button[type="submit"]')
  // Logged-in UI renders a <header>; the login screen does not.
  await page.waitForSelector('header', { timeout: 20000 })
  // Let the "Connected to MinIO" toast auto-dismiss so it doesn't cover the toolbar.
  await page.waitForFunction(() => !document.body.innerText.includes('Connected to MinIO'), { timeout: 8000 }).catch(() => {})
}

// Open a folder by visible name (grid or list view). Returns true if it navigated.
async function openFolder(page, name) {
  const clicked = await page.evaluate((folderName) => {
    const cards = Array.from(document.querySelectorAll('[data-fullpath][data-isdir="true"]'))
    for (const card of cards) {
      if ((card.textContent || '').includes(folderName)) {
        const target = card.querySelector('button') || card
        target.click()
        return true
      }
    }
    return false
  }, name)
  return clicked
}

async function main() {
  if (!USER || !PASS) {
    console.error('Set MINSTORAGE_USER and MINSTORAGE_PASS (the MinIO user/pass).')
    process.exit(1)
  }

  const executablePath = findChrome()
  console.log(`Using browser: ${executablePath}`)
  console.log(`Target app:    ${BASE_URL}`)
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--hide-scrollbars', '--force-color-profile=srgb'],
  })

  try {
    for (const t of TARGETS) {
      const page = await browser.newPage()
      await page.setViewport({
        width: t.width,
        height: t.height,
        deviceScaleFactor: t.deviceScaleFactor,
        isMobile: t.isMobile,
        hasTouch: t.hasTouch,
      })
      try {
        await login(page)
        await sleep(1200)
        if (ENTER_FOLDER) {
          const ok = await openFolder(page, ENTER_FOLDER)
          if (!ok) console.warn(`  (folder "${ENTER_FOLDER}" not found; capturing root)`)
        }
        // Give objects + thumbnails a moment to load.
        await sleep(3000)
        const out = path.join(OUT_DIR, `${t.name}.png`)
        await page.screenshot({ path: out })
        console.log(`✓ ${t.name.padEnd(7)} ${t.width}x${t.height}  ->  ${path.relative(process.cwd(), out)}`)
      } catch (err) {
        console.error(`✗ ${t.name}: ${err.message}`)
      } finally {
        await page.close()
      }
    }
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
