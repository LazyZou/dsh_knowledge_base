/**
 * PDF knowledge base — Host half.
 *
 * Owns the on-disk library, the `/api/pdfkb/*` Fetch routes the panel talks to,
 * and the `kb_*` tools the assistant uses inside a conversation. The panel never
 * calls a model: it answers extractively from stored chunks so that a topic the
 * library does not cover is reported as missing instead of being invented.
 *
 * Scanned documents are kept with their page images and recognized on demand, so
 * importing a scan always succeeds and pays recognition cost only for the pages
 * that have no text layer.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { KnowledgeBase } from './lib/store.mjs'
import { topicSummary } from './lib/clean.mjs'
import { probeTesseract, recognizePageImage, stripNonTextAnswer } from './lib/ocr.mjs'
import { JobStore, TERMINAL, progressOf, recover } from './lib/jobs.mjs'

export const name = 'pdf-kb'
export const inject = ['connection', 'tools', 'systemPrompt']

/** Route prefix shared by every endpoint of this plugin. */
const ROUTE = '/api/pdfkb'

/** Largest accepted upload: 500 MiB, comfortably above the 500,000 KB floor. */
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024
/** Human label for that limit. */
const MAX_UPLOAD_LABEL = '500 MB'
/** Pages recognized per OCR call when the caller does not choose. */
const DEFAULT_OCR_PAGES = 6
/** Pages recognized in parallel; local OCR is CPU bound and nothing is shared. */
const DEFAULT_OCR_CONCURRENCY = 4

/** JSON response helper. */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Group OCR failures so the panel can explain them in the user's language. */
function ocrErrorCode(message) {
  if (/^OCR_UNAVAILABLE/.test(message)) return 'OCR_UNAVAILABLE'
  if (/VISION_BACKEND_UNAVAILABLE|VISION_FAILED|rate limit/i.test(message)) return 'OCR_BACKEND_UNAVAILABLE'
  if (/^OCR_ABORTED/.test(message)) return 'OCR_ABORTED'
  return 'OCR_FAILED'
}

/** Map a thrown extraction/storage error onto a stable code the panel localizes. */
function failure(error) {
  const message = error instanceof Error ? error.message : String(error)
  const code = /^([A-Z_]+):/.exec(message)?.[1] ?? 'KB_ERROR'
  return { ok: false, code, message: message.replace(/^[A-Z_]+:\s*/, '') }
}

/** Trim the full document record down to what a citation line needs. */
function cite(hits) {
  return hits.map(({ text, ...rest }) => rest)
}

/** Match a document by exact id, exact title, then case-insensitive title. */
function matchDocument(documents, wanted) {
  const needle = String(wanted ?? '').trim()
  if (!needle) return undefined
  return documents.find(doc => doc.id === needle)
    ?? documents.find(doc => doc.title === needle)
    ?? documents.find(doc => doc.title.toLowerCase() === needle.toLowerCase())
}

/** Content hash of one page image, used to reuse text for repeated pages. */
async function hashFile(target) {
  const buffer = await fs.readFile(target)
  return crypto.createHash('sha1').update(buffer).digest('hex')
}

/** Collect the upload body into a temp file, rejecting anything over the cap. */
async function spoolUpload(request, tempDir, target) {
  await fs.mkdir(tempDir, { recursive: true })
  const temp = target ?? path.join(tempDir, `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}.pdf`)
  const handle = await fs.open(temp, 'w')
  let size = 0
  try {
    const body = request.body
    if (!body) throw new Error('PDF_EMPTY: empty upload')
    for await (const chunk of body) {
      const piece = Buffer.from(chunk)
      size += piece.length
      if (size > MAX_UPLOAD_BYTES) {
        const error = new Error(`PDF_TOO_LARGE: the file exceeds ${MAX_UPLOAD_LABEL}`)
        error.status = 413
        throw error
      }
      await handle.write(piece)
    }
  } catch (error) {
    await handle.close().catch(() => {})
    await fs.rm(temp, { force: true })
    throw error
  }
  await handle.close()
  return { temp, size }
}

export function apply(ctx, config) {
  const options = config && typeof config === 'object' ? config : {}
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const dataDir = path.join(home, 'pdfkb')
  const tempDir = path.join(dataDir, 'tmp')
  const kb = new KnowledgeBase(dataDir)
  const ocrEngine = ['auto', 'tesseract', 'vision'].includes(options.ocrEngine) ? options.ocrEngine : 'auto'
  const tesseractPath = typeof options.tesseractPath === 'string' ? options.tesseractPath : undefined
  const pagesPerRun = Math.max(1, Math.min(40, Number(options.pagesPerRun) || DEFAULT_OCR_PAGES))
  const ocrConcurrency = Math.max(1, Math.min(8, Number(options.concurrency) || DEFAULT_OCR_CONCURRENCY))

  /**
   * Recognize up to `pages` pending pages of one document.
   * Identical page images share one recognition result, so a scan that repeats a
   * header page never pays for it twice. Pages are recognized by a small worker
   * pool because a local Tesseract run is CPU bound and leaves cores idle.
   */
  async function recognizeDocument(id, requested) {
    const limit = Math.max(1, Math.min(40, Number(requested) || pagesPerRun))
    const queue = await kb.pendingOcr(id, limit)
    if (!queue.length) {
      const document = await kb.document(id)
      return { ok: true, recognized: 0, failed: 0, empty: 0, remaining: document.ocrPending, pages: [], done: true }
    }
    const digests = await Promise.all(queue.map(item => hashFile(item.path).catch(() => undefined)))
    const groups = new Map()
    queue.forEach((item, index) => {
      const key = digests[index] ?? `page:${item.page}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(item)
    })
    const pages = []
    let recognized = 0
    let failed = 0
    let empty = 0
    let stopped = false
    const workers = new Array(Math.max(1, Math.min(ocrConcurrency, groups.size))).fill(0)
    const targets = [...groups.values()]
    const outcomes = []
    let cursor = 0
    const runOne = async group => {
      const item = group[0]
      try {
        const result = await recognizePageImage(ctx, {
          imagePath: item.path,
          visionImagePath: item.visionPath,
          engine: ocrEngine,
          tesseractPath,
        })
        // A "no text on this page" answer must not become page content.
        const text = stripNonTextAnswer(result.text)
        const engine = text ? result.engine : `${String(result.engine).split(':')[0]}:none`
        outcomes.push({ group, text, engine })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        outcomes.push({ group, error: message, code: ocrErrorCode(message) })
        // No usable backend: stop instead of failing every remaining page.
        if (/^OCR_UNAVAILABLE/.test(message)) stopped = true
      }
    }
    await Promise.all(workers.map(async () => {
      while (!stopped) {
        const index = cursor++
        if (index >= targets.length) return
        await runOne(targets[index])
      }
    }))
    // Apply sequentially: applyOcr rewrites the whole document file.
    for (const outcome of outcomes) {
      if (outcome.error) {
        for (const page of outcome.group) {
          await kb.failOcr(id, page.page, outcome.error).catch(() => {})
          pages.push({ page: page.page, error: outcome.error, code: outcome.code })
        }
        failed += outcome.group.length
        continue
      }
      for (const page of outcome.group) {
        const engine = page === outcome.group[0] ? outcome.engine : `${outcome.engine}:reused`
        await kb.applyOcr(id, page.page, outcome.text, engine)
        pages.push({ page: page.page, chars: outcome.text.length, engine })
      }
      if (outcome.text) recognized += outcome.group.length
      else empty += outcome.group.length
    }
    pages.sort((a, b) => a.page - b.page)
    const document = await kb.document(id)
    return { ok: true, recognized, failed, empty, remaining: document.ocrPending, pages, done: document.ocrPending === 0 }
  }

  // ---- Background jobs ---------------------------------------------------
  // A batch of PDFs is imported by a single queue that survives refreshes and
  // restarts, so the panel can show progress even after it is closed.
  const jobStore = new JobStore(dataDir)
  let jobsReady
  let jobRunning = false
  // The job the runner is inside right now: a cancel can finalize a queued job
  // immediately, but a running one has to be stopped by the runner itself.
  let activeJob = null

  const fileExists = async target => {
    try {
      await fs.access(target)
      return true
    } catch {
      return false
    }
  }

  /** Load persisted jobs once and re-queue whatever a restart interrupted. */
  function ensureJobs() {
    if (!jobsReady) {
      jobsReady = (async () => {
        await jobStore.load()
        await fs.mkdir(tempDir, { recursive: true })
        if (await recover(jobStore.jobs, fileExists)) await jobStore.save()
        await sweepTemp()
      })()
    }
    return jobsReady
  }

  const jobView = job => ({ ...job, progress: progressOf(job) })

  function settled(item) {
    return TERMINAL.has(item.state)
  }

  /** Delete the spooled copies a job owns; a path import belongs to the caller. */
  async function dropSpooledFiles(job) {
    for (const item of job.items ?? []) {
      if (!item.tempFile || item.fromPath) continue
      await fs.rm(item.tempFile, { force: true }).catch(() => {})
      delete item.tempFile
    }
  }

  /**
   * Remove spool files no job claims. A crash mid-upload (or a job deleted from
   * an older build) would otherwise leave hundreds of megabytes in tmp/.
   */
  async function sweepTemp() {
    const claimed = new Set()
    for (const job of jobStore.jobs) {
      for (const item of job.items ?? []) if (item.tempFile) claimed.add(path.basename(item.tempFile))
    }
    const names = await fs.readdir(tempDir).catch(() => [])
    const cutoff = Date.now() - 10 * 60 * 1000
    for (const name of names) {
      if (!name.endsWith('.pdf') || claimed.has(name)) continue
      const target = path.join(tempDir, name)
      // An upload that is still streaming has no job row yet: leave fresh files.
      const stat = await fs.stat(target).catch(() => null)
      if (!stat || stat.mtimeMs > cutoff) continue
      await fs.rm(target, { force: true }).catch(() => {})
    }
  }

  async function finishJob(job) {
    const cancelled = job.cancelRequested
    const nothingSucceeded = job.done === 0 && job.failed > 0
    job.state = cancelled ? 'cancelled' : nothingSucceeded ? 'failed' : 'done'
    job.finishedAt = new Date().toISOString()
    job.message = cancelled
      ? 'cancelled'
      : nothingSucceeded
        ? 'every file failed'
        : `${job.done} ok${job.failed ? `, ${job.failed} failed` : ''}`
    // Files spooled for a job that never ran would otherwise sit in tmp/ forever.
    await dropSpooledFiles({ items: job.items.filter(item => item.state === 'cancelled') })
    return jobStore.save()
  }

  /**
   * Recognize every pending page of one document, batch by batch, while keeping
   * the job item's counters current. Stops on cancellation or when a batch makes
   * no progress at all (an unavailable backend must not spin forever).
   */
  async function recognizeAllPages(job, item, documentId) {
    let remaining = Number(item.remaining) || 0
    let stall = 0
    while (remaining > 0) {
      if (job.cancelRequested) return remaining
      const before = remaining
      const batch = await recognizeDocument(documentId, 40)
      item.recognized = (Number(item.recognized) || 0) + (Number(batch.recognized) || 0)
      item.remaining = Number(batch.remaining) || 0
      remaining = item.remaining
      await jobStore.touch(job)
      if (remaining >= before) {
        stall += 1
        if (stall >= 2) return remaining
      } else {
        stall = 0
      }
    }
    return remaining
  }

  async function runJobItem(job, item) {
    item.state = 'running'
    await jobStore.touch(job)
    try {
      if (job.kind === 'import') {
        const buffer = await fs.readFile(item.tempFile)
        const document = await kb.add({ buffer, fileName: item.name })
        item.documentId = document.id
        item.documentTitle = document.title
        item.pages = document.pageCount
        item.remaining = document.ocrPending
        job.done += 1
        if (job.autoOcr && document.ocrPending > 0) {
          await recognizeAllPages(job, item, document.id)
        }
        item.state = 'done'
      } else {
        const remaining = await recognizeAllPages(job, item, item.documentId)
        item.state = job.cancelRequested ? 'cancelled' : 'done'
        if (remaining > 0 && !job.cancelRequested) item.message = `${remaining} page(s) left`
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      item.state = 'failed'
      item.error = message
      item.code = /^([A-Z_]+):/.exec(message)?.[1] ?? 'KB_ERROR'
      job.failed += 1
    } finally {
      if (job.kind === 'import' && item.tempFile && !item.fromPath) {
        // Only spooled uploads are ours to delete: a path import belongs to the user.
        await fs.rm(item.tempFile, { force: true }).catch(() => {})
      }
      delete item.tempFile
      await jobStore.touch(job)
    }
  }

  /** Drain every unfinished job in creation order. Safe to call repeatedly. */
  async function runJobs() {
    await ensureJobs()
    if (jobRunning) return
    jobRunning = true
    try {
      for (;;) {
        const job = jobStore.jobs
          .filter(entry => !TERMINAL.has(entry.state))
          .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0]
        if (!job) break
        job.state = 'running'
        activeJob = job
        await jobStore.touch(job)
        for (const item of [...job.items].sort((a, b) => a.index - b.index)) {
          if (settled(item)) continue
          if (job.cancelRequested) {
            item.state = 'cancelled'
            continue
          }
          if (job.kind === 'import' && !item.uploaded) continue
          await runJobItem(job, item)
        }
        const unfinished = job.items.filter(item => !settled(item))
        if (!unfinished.length) {
          await finishJob(job)
          continue
        }
        if (!job.cancelRequested && job.kind === 'import' && unfinished.every(item => !item.uploaded)) {
          // Still waiting for the browser to finish sending the files.
          await jobStore.touch(job)
          break
        }
        for (const item of unfinished) item.state = 'cancelled'
        await finishJob(job)
      }
    } catch {
      // A queue failure must never take the route down; items keep their state.
    } finally {
      activeJob = null
      jobRunning = false
    }
  }

  const kickJobs = () => {
    void runJobs().catch(() => {})
  }

  // ---- HTTP routes -------------------------------------------------------
  const route = (suffix, methods, requestBody, fetch) => {
    ctx.effect(
      () => ctx.connection.fetch.register({ path: `${ROUTE}${suffix}`, methods, requestBody, fetch }),
      `pdf-kb: route ${suffix}`,
    )
  }

  route('/state', ['GET'], 'buffered', async () => {
    try {
      const documents = await kb.list()
      const tesseract = await probeTesseract(tesseractPath)
      return json({
        ok: true,
        documents,
        totals: {
          documents: documents.length,
          pages: documents.reduce((sum, doc) => sum + (doc.pageCount ?? 0), 0),
          chunks: documents.reduce((sum, doc) => sum + (doc.chunkCount ?? 0), 0),
          topics: documents.reduce((sum, doc) => sum + (doc.topicCount ?? 0), 0),
          ocrPending: documents.reduce((sum, doc) => sum + (doc.ocrPending ?? 0), 0),
        },
        ocr: { engine: ocrEngine, tesseract: tesseract.available, language: tesseract.language ?? null },
        limits: { maxBytes: MAX_UPLOAD_BYTES, maxLabel: MAX_UPLOAD_LABEL },
      })
    } catch (error) {
      return json(failure(error), 500)
    }
  })

  route('/upload', ['POST'], 'streaming', async request => {
    let temp
    try {
      const url = new URL(request.url)
      const fileName = url.searchParams.get('name') ?? 'document.pdf'
      const spooled = await spoolUpload(request, tempDir)
      temp = spooled.temp
      if (!spooled.size) return json({ ok: false, code: 'PDF_EMPTY', message: 'empty upload' }, 400)
      const buffer = await fs.readFile(temp)
      const document = await kb.add({ buffer, fileName })
      return json({ ok: true, document })
    } catch (error) {
      return json(failure(error), error?.status === 413 ? 413 : 400)
    } finally {
      if (temp) await fs.rm(temp, { force: true }).catch(() => {})
    }
  })

  route('/document', ['GET'], 'buffered', async request => {
    try {
      const id = new URL(request.url).searchParams.get('id')
      if (!id) return json({ ok: false, code: 'KB_BAD_REQUEST', message: 'missing id' }, 400)
      const document = await kb.document(id)
      return json({ ok: true, document })
    } catch (error) {
      return json(failure(error), 404)
    }
  })

  route('/chunks', ['GET'], 'buffered', async request => {
    try {
      const id = new URL(request.url).searchParams.get('doc')
      if (id) {
        const document = await kb.document(id)
        return json({ ok: true, chunks: document.chunks, topics: document.topics ?? [] })
      }
      const chunks = await kb.allChunks()
      return json({ ok: true, chunks, topics: topicSummary(chunks) })
    } catch (error) {
      return json(failure(error), 404)
    }
  })

  route('/delete', ['POST'], 'buffered', async request => {
    try {
      const body = await request.json().catch(() => ({}))
      const removed = await kb.remove(String(body?.id ?? ''))
      return json({ ok: removed })
    } catch (error) {
      return json(failure(error), 400)
    }
  })

  route('/ask', ['POST'], 'buffered', async request => {
    try {
      const body = await request.json().catch(() => ({}))
      const question = String(body?.question ?? '').trim()
      if (!question) return json({ ok: false, code: 'KB_BAD_REQUEST', message: 'empty question' }, 400)
      const answer = await kb.answer(question, 4)
      return json({ ok: true, ...answer, sources: cite(answer.sources ?? []) })
    } catch (error) {
      return json(failure(error), 500)
    }
  })

  route('/search', ['GET'], 'buffered', async request => {
    try {
      const url = new URL(request.url)
      const query = url.searchParams.get('q') ?? ''
      const limit = Math.max(1, Math.min(20, Number(url.searchParams.get('limit') ?? 5) || 5))
      const result = await kb.search(query, limit)
      return json({ ok: true, ...result, hits: cite(result.hits) })
    } catch (error) {
      return json(failure(error), 500)
    }
  })

  route('/ocr', ['POST'], 'buffered', async request => {
    try {
      const body = await request.json().catch(() => ({}))
      const id = String(body?.id ?? '').trim()
      if (!id) return json({ ok: false, code: 'KB_BAD_REQUEST', message: 'missing id' }, 400)
      const result = await recognizeDocument(id, body?.pages)
      return json(result)
    } catch (error) {
      return json(failure(error), 400)
    }
  })

  route('/page-image', ['GET'], 'buffered', async request => {
    try {
      const url = new URL(request.url)
      const id = url.searchParams.get('id') ?? ''
      const page = Number(url.searchParams.get('page') ?? 0)
      if (!id || !Number.isFinite(page) || page < 1) {
        return json({ ok: false, code: 'KB_BAD_REQUEST', message: 'missing id or page' }, 400)
      }
      const image = await kb.pageImage(id, page)
      if (!image) return json({ ok: false, code: 'PDF_NO_TEXT', message: 'that page has no stored image' }, 404)
      const bytes = await fs.readFile(image.path)
      return new Response(bytes, {
        status: 200,
        headers: { 'content-type': image.mediaType, 'cache-control': 'private, max-age=3600' },
      })
    } catch (error) {
      return json(failure(error), 404)
    }
  })

  // ---- Background job routes ---------------------------------------------
  route('/jobs/import', ['POST'], 'buffered', async request => {
    try {
      await ensureJobs()
      const body = await request.json().catch(() => ({}))
      const files = Array.isArray(body?.files) ? body.files : []
      const wanted = files
        .map(file => ({ name: String(file?.name ?? 'document.pdf'), size: Number(file?.size) || 0 }))
        .filter(file => file.name)
        .slice(0, 100)
      if (!wanted.length) return json({ ok: false, code: 'KB_BAD_REQUEST', message: 'no files' }, 400)
      const tooBig = wanted.find(file => file.size > MAX_UPLOAD_BYTES)
      if (tooBig) {
        return json({ ok: false, code: 'PDF_TOO_LARGE', message: `${tooBig.name} exceeds ${MAX_UPLOAD_LABEL}` }, 413)
      }
      const job = jobStore.create({
        kind: 'import',
        title: wanted.length === 1 ? wanted[0].name : `${wanted.length} 个 PDF`,
        items: wanted,
      })
      job.autoOcr = body?.autoOcr !== false
      await jobStore.touch(job)
      kickJobs()
      return json({ ok: true, job: jobView(job) })
    } catch (error) {
      return json(failure(error), 400)
    }
  })

  route('/job-file', ['POST'], 'streaming', async request => {
    let temp
    try {
      await ensureJobs()
      const url = new URL(request.url)
      const jobId = url.searchParams.get('job') ?? ''
      const index = Number(url.searchParams.get('index') ?? -1)
      const name = url.searchParams.get('name') ?? undefined
      const job = jobStore.get(jobId)
      if (!job) return json({ ok: false, code: 'KB_BAD_REQUEST', message: 'unknown job' }, 404)
      const item = job.items.find(entry => entry.index === index)
      if (!item) return json({ ok: false, code: 'KB_BAD_REQUEST', message: 'unknown file' }, 404)
      // A cancelled batch keeps receiving files from the browser until it notices, so
      // refuse them instead of resurrecting a row the user already stopped.
      if (job.cancelRequested || item.state === 'cancelled') {
        return json({ ok: false, code: 'KB_CANCELLED', message: 'the job was cancelled' }, 409)
      }
      if (name) item.name = name
      temp = path.join(tempDir, `job-${job.id}-${item.index}.pdf`)
      const spooled = await spoolUpload(request, tempDir, temp)
      temp = spooled.temp
      if (!spooled.size) return json({ ok: false, code: 'PDF_EMPTY', message: 'empty upload' }, 400)
      item.uploaded = true
      item.size = spooled.size
      item.tempFile = temp
      item.state = 'uploaded'
      await jobStore.touch(job)
      kickJobs()
      return json({ ok: true, job: jobView(job) })
    } catch (error) {
      if (temp) await fs.rm(temp, { force: true }).catch(() => {})
      return json(failure(error), error?.status === 413 ? 413 : 400)
    }
  })

  route('/jobs', ['GET'], 'buffered', async () => {
    try {
      await ensureJobs()
      const jobs = jobStore.list().map(jobView)
      return json({ ok: true, jobs, active: jobs.filter(job => !TERMINAL.has(job.state)).length })
    } catch (error) {
      return json(failure(error), 500)
    }
  })

  route('/job', ['GET'], 'buffered', async request => {
    try {
      await ensureJobs()
      const id = new URL(request.url).searchParams.get('id') ?? ''
      const job = jobStore.get(id)
      if (!job) return json({ ok: false, code: 'KB_BAD_REQUEST', message: 'unknown job' }, 404)
      return json({ ok: true, job: jobView(job) })
    } catch (error) {
      return json(failure(error), 500)
    }
  })

  route('/job-cancel', ['POST'], 'buffered', async request => {
    try {
      await ensureJobs()
      const body = await request.json().catch(() => ({}))
      const job = jobStore.get(String(body?.id ?? ''))
      if (!job) return json({ ok: false, code: 'KB_BAD_REQUEST', message: 'unknown job' }, 404)
      if (TERMINAL.has(job.state)) return json({ ok: true, job: jobView(job) })
      job.cancelRequested = true
      const running = jobRunning && activeJob === job
      // Everything the runner has not picked up can stop right now; the item it is
      // inside finishes on its own and the runner then closes the job out.
      for (const item of job.items) {
        if (settled(item) || (running && item.state === 'running')) continue
        item.state = 'cancelled'
      }
      if (running) {
        job.state = 'cancelling'
        await jobStore.touch(job)
      } else {
        await finishJob(job)
      }
      kickJobs()
      return json({ ok: true, job: jobView(job) })
    } catch (error) {
      return json(failure(error), 400)
    }
  })

  route('/job-delete', ['POST'], 'buffered', async request => {
    try {
      await ensureJobs()
      const body = await request.json().catch(() => ({}))
      const job = jobStore.get(String(body?.id ?? ''))
      if (!job) return json({ ok: true, removed: false })
      if (!TERMINAL.has(job.state)) {
        return json({ ok: false, code: 'KB_BAD_REQUEST', message: 'cancel the job first' }, 400)
      }
      jobStore.remove(job.id)
      await jobStore.save()
      // Files spooled for this job are ours; leaving them behind fills tmp/.
      await dropSpooledFiles(job)
      return json({ ok: true, removed: true })
    } catch (error) {
      return json(failure(error), 400)
    }
  })

  route('/jobs/ocr', ['POST'], 'buffered', async request => {
    try {
      await ensureJobs()
      const body = await request.json().catch(() => ({}))
      const documents = await kb.list()
      const document = matchDocument(documents, body?.id ?? body?.document)
      if (!document) return json({ ok: false, code: 'KB_BAD_REQUEST', message: 'unknown document' }, 404)
      const pending = Number(document.ocrPending) || 0
      if (!pending) return json({ ok: true, job: null, message: 'nothing to recognize' })
      const job = jobStore.create({
        kind: 'ocr',
        title: document.title,
        items: [{ name: document.title }],
      })
      const item = job.items[0]
      item.documentId = document.id
      item.documentTitle = document.title
      item.pages = pending
      item.remaining = pending
      item.state = 'uploaded'
      item.uploaded = true
      await jobStore.touch(job)
      kickJobs()
      return json({ ok: true, job: jobView(job) })
    } catch (error) {
      return json(failure(error), 400)
    }
  })

  // ---- Model-facing tools ------------------------------------------------
  const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, undefined, 2) }]

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'kb_search',
        description:
          'Search the user\'s PDF knowledge base and return the most relevant passages with their document title '
          + 'and page. Use this before answering any question that may be covered by documents the user uploaded. '
          + 'When the result lists no passages, or reports `missing: true`, the knowledge base does not cover the '
          + 'question: say so plainly instead of answering from general knowledge.',
        parameters: {
          query: { type: 'string', required: true, description: 'The question or keywords to look up.' },
          limit: { type: 'number', description: 'Maximum passages to return; defaults to 5, at most 20.' },
        },
        output: { schema: {}, render: renderJson },
        isConcurrencySafe: () => true,
        async execute(args) {
          const query = String(args?.query ?? '').trim()
          if (!query) return { ok: false, error: 'query must not be empty', hits: [] }
          const limit = Math.max(1, Math.min(20, Number(args?.limit ?? 5) || 5))
          const result = await kb.search(query, limit)
          return {
            ok: true,
            missing: !result.hits.length || result.coverage < 0.34,
            coverage: Number(result.coverage.toFixed(2)),
            hits: result.hits.map(hit => ({
              document: hit.document,
              page: hit.page,
              topic: hit.topic || undefined,
              score: hit.score,
              excerpt: hit.excerpt,
            })),
          }
        },
      }),
    'pdf-kb: kb_search tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'kb_topics',
        description:
          'List how the knowledge of one PDF is grouped by topic, with the pages each topic covers. Use it to orient '
          + 'in a long book before searching, or when the user asks what subjects a document covers. Accepts the exact '
          + 'document title from kb_documents or its id.',
        parameters: {
          document: { type: 'string', required: true, description: 'Document title or id from kb_documents.' },
        },
        output: { schema: {}, render: renderJson },
        isConcurrencySafe: () => true,
        async execute(args) {
          const wanted = String(args?.document ?? '').trim()
          const documents = await kb.list()
          const meta = matchDocument(documents, wanted)
          if (!meta) {
            return { ok: false, error: `no document matches "${wanted}"`, documents: documents.map(doc => doc.title) }
          }
          const document = await kb.document(meta.id)
          return {
            ok: true,
            document: document.title,
            topicCount: (document.topics ?? []).length,
            topics: (document.topics ?? []).map(topic => ({
              topic: topic.name || '(untitled)',
              chunks: topic.chunkCount,
              pages: topic.firstPage === topic.lastPage ? `${topic.firstPage}` : `${topic.firstPage}-${topic.lastPage}`,
            })),
          }
        },
      }),
    'pdf-kb: kb_topics tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'kb_documents',
        description:
          'List every document stored in the user\'s PDF knowledge base with its title, page count, topic count, chunk count, '
          + 'pending scanned pages, and a short opening preview. Call this when the user asks what the knowledge base '
          + 'contains or which document covers a topic, then use kb_search or kb_read_document to look inside.',
        parameters: {},
        output: { schema: {}, render: renderJson },
        isConcurrencySafe: () => true,
        async execute() {
          const documents = await kb.list()
          return { ok: true, count: documents.length, documents }
        },
      }),
    'pdf-kb: kb_documents tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'kb_read_document',
        description:
          'Read the extracted text of one PDF in the knowledge base, optionally a single page. Accepts the exact '
          + 'document title returned by kb_documents, or its id. Use it when the excerpts from kb_search are not '
          + 'enough to answer precisely. Pages that are still scans carry empty text until kb_ocr recognizes them.',
        parameters: {
          document: { type: 'string', required: true, description: 'Document title or id from kb_documents.' },
          page: { type: 'number', description: '1-based page to read; omit for the whole document.' },
        },
        output: { schema: {}, render: renderJson },
        isConcurrencySafe: () => true,
        async execute(args) {
          const wanted = String(args?.document ?? '').trim()
          const documents = await kb.list()
          const meta = matchDocument(documents, wanted)
          if (!meta) {
            return { ok: false, error: `no document matches "${wanted}"`, documents: documents.map(doc => doc.title) }
          }
          const document = await kb.document(meta.id)
          const page = Number(args?.page)
          if (Number.isFinite(page) && page > 0) {
            const slice = document.pages.find(item => item.page === page)
            if (!slice) return { ok: false, error: `page ${page} is out of range (1-${document.pageCount})` }
            return {
              ok: true,
              document: document.title,
              page: slice.page,
              ocrStatus: slice.ocrStatus,
              text: slice.text,
            }
          }
          return {
            ok: true,
            document: document.title,
            pageCount: document.pageCount,
            ocrPending: document.ocrPending,
            pages: document.pages,
          }
        },
      }),
    'pdf-kb: kb_read_document tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'kb_add_document',
        description:
          'Add one PDF from a local file path to the user\'s knowledge base: the plugin parses its text, stores the '
          + 'pages, and indexes knowledge chunks. A scanned PDF is accepted too; its pages wait for kb_ocr. Use this '
          + 'when the user asks you to add or import a PDF they named by path. Uploading through the PDF library panel '
          + 'keeps working independently.',
        parameters: {
          path: { type: 'string', required: true, description: 'Absolute path of the PDF file on this machine.' },
          name: { type: 'string', description: 'Optional display name; defaults to the file base name.' },
        },
        output: { schema: {}, render: renderJson },
        isConcurrencySafe: () => false,
        async execute(args) {
          const target = String(args?.path ?? '').trim()
          if (!target) return { ok: false, error: 'path must not be empty' }
          let buffer
          try {
            buffer = await fs.readFile(target)
          } catch (error) {
            return { ok: false, error: `cannot read ${target}: ${error.message}` }
          }
          if (!buffer.length) return { ok: false, code: 'PDF_EMPTY', error: 'the file is empty' }
          if (buffer.length > MAX_UPLOAD_BYTES) {
            return { ok: false, code: 'PDF_TOO_LARGE', error: `the file exceeds ${MAX_UPLOAD_LABEL}` }
          }
          try {
            const document = await kb.add({
              buffer,
              fileName: String(args?.name ?? '').trim() || path.basename(target),
            })
            return { ok: true, duplicate: Boolean(document.duplicate), document }
          } catch (error) {
            return { ok: false, ...failure(error) }
          }
        },
      }),
    'pdf-kb: kb_add_document tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'kb_ocr',
        description:
          'Recognize the scanned (image-only) pages of one PDF in the knowledge base. Recognition prefers a local '
          + 'Tesseract install, which costs no tokens, and otherwise uses the vision tool available in this '
          + 'conversation. It works through a few pages per call and reports what remains, so call it repeatedly '
          + 'until `remaining` is 0. Use it when the user asks about a scanned document, or when kb_search finds '
          + 'nothing because the pages have no text layer yet.',
        parameters: {
          document: { type: 'string', required: true, description: 'Document title or id from kb_documents.' },
          pages: { type: 'number', description: 'How many pending pages to recognize now; 1-40, defaults to 6.' },
        },
        output: { schema: {}, render: renderJson },
        isConcurrencySafe: () => false,
        async execute(args) {
          const documents = await kb.list()
          const meta = matchDocument(documents, args?.document)
          if (!meta) {
            return {
              ok: false,
              error: `no document matches "${String(args?.document ?? '')}"`,
              documents: documents.map(doc => doc.title),
            }
          }
          if (!meta.ocrPending) return { ok: true, document: meta.title, recognized: 0, remaining: 0, done: true }
          const result = await recognizeDocument(meta.id, args?.pages)
          return { ...result, document: meta.title }
        },
      }),
    'pdf-kb: kb_ocr tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'kb_import',
        description:
          'Queue several PDF files from this machine for import in the background, then report progress. The queue '
          + 'keeps running after the call returns (it is visible in the PDF library panel), so use kb_jobs to check on '
          + 'it. Scanned files are recognized as part of the import unless recognize is false. Use this when the user '
          + 'names more than one PDF to add at once.',
        parameters: {
          paths: { type: 'array', required: true, description: 'Absolute paths of the PDF files to import.' },
          recognize: { type: 'boolean', description: 'Also recognize scanned pages; defaults to true.' },
        },
        output: { schema: {}, render: renderJson },
        isConcurrencySafe: () => false,
        async execute(args) {
          await ensureJobs()
          const paths = (Array.isArray(args?.paths) ? args.paths : []).map(String).filter(Boolean).slice(0, 100)
          if (!paths.length) return { ok: false, error: 'no paths given' }
          const files = []
          const missing = []
          for (const target of paths) {
            try {
              const stat = await fs.stat(target)
              if (!stat.isFile()) {
                missing.push(target)
                continue
              }
              if (stat.size > MAX_UPLOAD_BYTES) {
                return { ok: false, code: 'PDF_TOO_LARGE', error: `${path.basename(target)} exceeds ${MAX_UPLOAD_LABEL}` }
              }
              files.push({ name: path.basename(target), path: target, size: stat.size })
            } catch {
              missing.push(target)
            }
          }
          if (!files.length) return { ok: false, error: 'none of those paths exist', missing }
          const job = jobStore.create({ kind: 'import', title: files.length === 1 ? files[0].name : `${files.length} 个 PDF`, items: files })
          job.autoOcr = args?.recognize !== false
          for (const [index, file] of files.entries()) {
            const item = job.items[index]
            item.uploaded = true
            item.state = 'uploaded'
            item.size = file.size
            item.tempFile = file.path
            item.fromPath = true
          }
          await jobStore.touch(job)
          kickJobs()
          return { ok: true, job: jobView(job), missing, hint: 'call kb_jobs to follow progress' }
        },
      }),
    'pdf-kb: kb_import tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'kb_jobs',
        description:
          'Report the background import and recognition jobs of the PDF knowledge base: each job\'s state, how many '
          + 'files or pages are done, and any per-file error. Call this when the user asks how an import is going or '
          + 'whether their uploads finished.',
        parameters: {
          job: { type: 'string', description: 'Optional job id; omit for every recent job.' },
        },
        output: { schema: {}, render: renderJson },
        isConcurrencySafe: () => true,
        async execute(args) {
          await ensureJobs()
          const wanted = String(args?.job ?? '').trim()
          if (wanted) {
            const job = jobStore.get(wanted)
            if (!job) return { ok: false, error: `no job matches "${wanted}"`, jobs: jobStore.list().map(entry => entry.id) }
            return { ok: true, job: jobView(job) }
          }
          const jobs = jobStore.list().map(jobView)
          return {
            ok: true,
            active: jobs.filter(job => !TERMINAL.has(job.state)).length,
            jobs: jobs.map(job => ({
              id: job.id,
              kind: job.kind,
              title: job.title,
              state: job.state,
              done: job.progress.done,
              total: job.progress.total,
              failed: job.failed,
              items: job.items.map(item => ({
                name: item.name,
                state: item.state,
                documentId: item.documentId ?? null,
                // An empty string rather than undefined: tool values must be lossless JSON.
                error: item.error || '',
              })),
            })),
          }
        },
      }),
    'pdf-kb: kb_jobs tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'kb_remove_document',
        description:
          'Remove one PDF, together with every knowledge chunk extracted from it, from the user\'s knowledge base. '
          + 'Accepts the exact title from kb_documents or its id. Use this when the user asks to delete, forget, or '
          + 'replace a document.',
        parameters: {
          document: { type: 'string', required: true, description: 'Document title or id from kb_documents.' },
        },
        output: { schema: {}, render: renderJson },
        isConcurrencySafe: () => false,
        async execute(args) {
          const documents = await kb.list()
          const meta = matchDocument(documents, args?.document)
          if (!meta) {
            return {
              ok: false,
              error: `no document matches "${String(args?.document ?? '')}"`,
              documents: documents.map(doc => doc.title),
            }
          }
          const removed = await kb.remove(meta.id)
          return { ok: true, removed, document: meta.title, chunkCount: meta.chunkCount }
        },
      }),
    'pdf-kb: kb_remove_document tool',
  )

  // ---- Prompt guidance ---------------------------------------------------
  ctx.effect(
    () => ctx.systemPrompt.section({
      name: 'pdf-kb:guidance',
      order: 1750,
      interpolate: false,
      text:
        'The user keeps a PDF knowledge base, reachable through the kb_search, kb_documents, kb_topics, and '
        + 'kb_read_document tools, and maintained through kb_add_document, kb_import, kb_ocr, kb_jobs, and '
        + 'kb_remove_document. When a question could be answered from their documents, search that library first and '
        + 'cite the document title and page you used. kb_topics shows how one document is grouped by section when you '
        + 'need to orient in a long book. Documents listed with a non-zero `ocrPending` are scans whose pages have no '
        + 'text yet: call kb_ocr for them before concluding the library lacks the answer. Importing several PDFs is a '
        + 'background job: start it with kb_import and follow it with kb_jobs instead of waiting inside one call. If '
        + 'the search returns nothing relevant, tell the user the knowledge base does not contain that knowledge, and '
        + 'only then offer general knowledge clearly labelled as not from the library.',
    }),
    'pdf-kb: prompt section',
  )
}
