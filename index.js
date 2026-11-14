/**
 * PDF knowledge base — Host half.
 *
 * Owns the on-disk library, the `/api/pdfkb/*` Fetch routes the panel talks to,
 * and the `kb_*` tools the assistant uses inside a conversation. The panel never
 * calls a model: it answers extractively from stored chunks so that a topic the
 * library does not cover is reported as missing instead of being invented.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { KnowledgeBase } from './lib/store.mjs'

export const name = 'pdf-kb'
export const inject = ['connection', 'tools', 'systemPrompt']

/** Route prefix shared by every endpoint of this plugin. */
const ROUTE = '/api/pdfkb'

/** Largest accepted upload. */
const MAX_UPLOAD_BYTES = 96 * 1024 * 1024

/** JSON response helper. */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
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

export function apply(ctx) {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const kb = new KnowledgeBase(path.join(home, 'pdfkb'))

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
      return json({
        ok: true,
        documents,
        totals: {
          documents: documents.length,
          pages: documents.reduce((sum, doc) => sum + (doc.pageCount ?? 0), 0),
          chunks: documents.reduce((sum, doc) => sum + (doc.chunkCount ?? 0), 0),
        },
      })
    } catch (error) {
      return json(failure(error), 500)
    }
  })

  route('/upload', ['POST'], 'buffered', async request => {
    try {
      const url = new URL(request.url)
      const fileName = url.searchParams.get('name') ?? 'document.pdf'
      const buffer = Buffer.from(await request.arrayBuffer())
      if (!buffer.length) return json({ ok: false, code: 'PDF_EMPTY', message: 'empty upload' }, 400)
      if (buffer.length > MAX_UPLOAD_BYTES) {
        return json({ ok: false, code: 'PDF_TOO_LARGE', message: 'the file exceeds 96 MB' }, 413)
      }
      const document = await kb.add({ buffer, fileName })
      return json({ ok: true, document })
    } catch (error) {
      return json(failure(error), 400)
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
          'List every document stored in the user\'s PDF knowledge base with its title, page count, chunk count, and '
          + 'a short opening preview. Call this when the user asks what the knowledge base contains or which document '
          + 'covers a topic, then use kb_search or kb_read_document to look inside.',
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
          + 'enough to answer precisely.',
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
            if (!slice) return { ok: false, error: `page ${page} is out of range (1–${document.pageCount})` }
            return { ok: true, document: document.title, page: slice.page, text: slice.text }
          }
          return {
            ok: true,
            document: document.title,
            pageCount: document.pageCount,
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
          + 'pages, and indexes knowledge chunks. Use this when the user asks you to add or import a PDF they named by '
          + 'path. Uploading through the PDF library panel keeps working independently.',
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
            return { ok: false, code: 'PDF_TOO_LARGE', error: 'the file exceeds 96 MB' }
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
        + 'tools, and maintained through kb_add_document and kb_remove_document. When a question could be answered '
        + 'from their documents, search that library first and cite the document title and page you used. If the '
        + 'search returns nothing relevant, tell the user the knowledge base does not contain that knowledge, and '
        + 'only then offer general knowledge clearly labelled as not from the library.',
    }),
    'pdf-kb: prompt section',
  )
}
