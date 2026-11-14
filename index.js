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
import { probeTesseract, recognizePageImage, stripNonTextAnswer } from './lib/ocr.mjs'

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
async function spoolUpload(request, tempDir) {
  await fs.mkdir(tempDir, { recursive: true })
  const temp = path.join(tempDir, `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}.pdf`)
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

  /**
   * Recognize up to `pages` pending pages of one document.
   * Identical page images share one recognition result, so a scan that repeats a
   * header page never pays for it twice.
   */
  async function recognizeDocument(id, requested) {
    const limit = Math.max(1, Math.min(40, Number(requested) || pagesPerRun))
    const queue = await kb.pendingOcr(id, limit)
    if (!queue.length) {
      const document = await kb.document(id)
      return { ok: true, recognized: 0, failed: 0, empty: 0, remaining: document.ocrPending, pages: [], done: true }
    }
    const reused = new Map()
    const pages = []
    let recognized = 0
    let failed = 0
    let empty = 0
    let stopped = false
    for (const item of queue) {
      if (stopped) break
      const digest = await hashFile(item.path).catch(() => undefined)
      if (digest && reused.has(digest)) {
        const cached = reused.get(digest)
        await kb.applyOcr(id, item.page, cached.text, `${cached.engine}:reused`)
        pages.push({ page: item.page, chars: cached.text.length, engine: `${cached.engine}:reused` })
        if (cached.text) recognized += 1
        else empty += 1
        continue
      }
      try {
        const result = await recognizePageImage(ctx, {
          imagePath: item.path,
          engine: ocrEngine,
          tesseractPath,
        })
        // A "no text on this page" answer must not become page content.
        const text = stripNonTextAnswer(result.text)
        const engine = text ? result.engine : `${String(result.engine).split(':')[0]}:none`
        if (digest) reused.set(digest, { text, engine })
        await kb.applyOcr(id, item.page, text, engine)
        pages.push({ page: item.page, chars: text.length, engine })
        if (text) recognized += 1
        else empty += 1
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await kb.failOcr(id, item.page, message).catch(() => {})
        pages.push({ page: item.page, error: message, code: ocrErrorCode(message) })
        failed += 1
        // No usable backend: stop instead of failing every remaining page.
        if (/^OCR_UNAVAILABLE/.test(message)) stopped = true
      }
    }
    const document = await kb.document(id)
    return { ok: true, recognized, failed, empty, remaining: document.ocrPending, pages, done: document.ocrPending === 0 }
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
      const chunks = id
        ? (await kb.document(id)).chunks.map(chunk => ({ ...chunk, documentId: id }))
        : await kb.allChunks()
      return json({ ok: true, chunks })
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
        name: 'kb_documents',
        description:
          'List every document stored in the user\'s PDF knowledge base with its title, page count, chunk count, '
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
        'The user keeps a PDF knowledge base, reachable through the kb_search, kb_documents, and kb_read_document '
        + 'tools, and maintained through kb_add_document, kb_ocr, and kb_remove_document. When a question could be '
        + 'answered from their documents, search that library first and cite the document title and page you used. '
        + 'Documents listed with a non-zero `ocrPending` are scans whose pages have no text yet: call kb_ocr for them '
        + 'before concluding the library lacks the answer. If the search returns nothing relevant, tell the user the '
        + 'knowledge base does not contain that knowledge, and only then offer general knowledge clearly labelled as '
        + 'not from the library.',
    }),
    'pdf-kb: prompt section',
  )
}
