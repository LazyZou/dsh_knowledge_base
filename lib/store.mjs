/**
 * PDF knowledge base storage and retrieval.
 *
 * Documents live under `<dataDir>/docs/<id>.json` and are summarised in
 * `<dataDir>/index.json`. Retrieval is BM25 over overlapping page chunks; the
 * panel answer is extractive so it can never invent facts from outside the
 * library, which is what lets the UI report a missing topic honestly.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { extractPdfText } from './pdf.mjs'

/** Chunk size in characters; large enough to keep a paragraph's context. */
const CHUNK_SIZE = 900
/** Overlap in characters between neighbouring chunks of the same page. */
const CHUNK_OVERLAP = 120
/** Fraction of the query terms a chunk must match to count as relevant. */
const MIN_COVERAGE = 0.34
/** BM25 parameters. */
const K1 = 1.2
const B = 0.75

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/**
 * Split text into retrieval tokens: ASCII words plus CJK unigrams and bigrams.
 * Chinese has no spaces, so single characters keep recall and bigrams supply
 * most of the precision.
 */
export function tokenize(text) {
  const tokens = []
  const lowered = text.toLowerCase()
  let run = ''
  const flushRun = () => {
    if (run.length >= 2) tokens.push(run)
    run = ''
  }
  for (const char of lowered) {
    if (CJK.test(char)) {
      tokens.push(char)
      run += char
      if (run.length >= 2) {
        tokens.push(run.slice(-2))
        run = run.slice(-1)
      }
    } else if (/[a-z0-9]/.test(char)) {
      run += char
    } else {
      flushRun()
    }
  }
  flushRun()
  return tokens
}

/** Split one page's text into overlapping chunks aligned to line breaks. */
function chunkPage(text, page) {
  const clean = text.trim()
  if (!clean) return []
  if (clean.length <= CHUNK_SIZE) return [{ page, text: clean }]
  const chunks = []
  let start = 0
  while (start < clean.length) {
    let end = Math.min(clean.length, start + CHUNK_SIZE)
    if (end < clean.length) {
      const slice = clean.slice(start, end)
      const breakAt = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('\n'), slice.lastIndexOf('。 '))
      if (breakAt > CHUNK_SIZE * 0.5) end = start + breakAt + 1
    }
    const piece = clean.slice(start, end).trim()
    if (piece) chunks.push({ page, text: piece })
    if (end >= clean.length) break
    start = Math.max(end - CHUNK_OVERLAP, start + 1)
  }
  return chunks
}

/** Build the chunk list for a document's pages. */
function buildChunks(pages) {
  const chunks = []
  pages.forEach((text, index) => {
    for (const piece of chunkPage(text, index + 1)) {
      chunks.push({ id: `${index + 1}-${chunks.length + 1}`, page: piece.page, text: piece.text })
    }
  })
  return chunks
}

/** Rough sentence split used to assemble an extractive answer. */
function splitSentences(text) {
  const parts = text.split(/(?<=[。！？；!?;])\s*|(?<=\.)\s+/)
  return parts.map(part => part.trim()).filter(part => part.length > 1)
}

/** One retrieved passage. */
function excerptOf(text, limit = 320) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

export class KnowledgeBase {
  constructor(dir) {
    this.dir = dir
    this.indexPath = path.join(dir, 'index.json')
    this.docsDir = path.join(dir, 'docs')
    this.index = undefined
    this.docCache = new Map()
    this.revision = 0
  }

  /** Read the on-disk index once. */
  async loadIndex() {
    if (this.index) return this.index
    try {
      const text = await fs.readFile(this.indexPath, 'utf8')
      const parsed = JSON.parse(text)
      this.index = { version: 1, documents: Array.isArray(parsed.documents) ? parsed.documents : [] }
    } catch {
      this.index = { version: 1, documents: [] }
    }
    return this.index
  }

  /** Persist the index after a mutation. */
  async saveIndex() {
    await fs.mkdir(this.docsDir, { recursive: true })
    const body = JSON.stringify(this.index, undefined, 2)
    const temp = `${this.indexPath}.${process.pid}.tmp`
    await fs.writeFile(temp, body, 'utf8')
    await fs.rename(temp, this.indexPath)
  }

  /** Load one document file, cached in memory. */
  async loadDocument(id) {
    if (this.docCache.has(id)) return this.docCache.get(id)
    const file = path.join(this.docsDir, `${id}.json`)
    const text = await fs.readFile(file, 'utf8')
    const doc = JSON.parse(text)
    this.docCache.set(id, doc)
    return doc
  }

  /** Metadata for every stored document, newest first. */
  async list() {
    const index = await this.loadIndex()
    return [...index.documents].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  /** Parse, chunk, and store one PDF upload. */
  async add({ buffer, fileName }) {
    const hash = crypto.createHash('sha1').update(buffer).digest('hex')
    const index = await this.loadIndex()
    const existing = index.documents.find(entry => entry.hash === hash)
    if (existing) return { ...this.summaryOfInIndex(existing), duplicate: true }
    const extracted = extractPdfText(buffer)
    const pages = extracted.pages
    const total = pages.reduce((sum, page) => sum + page.trim().length, 0)
    if (!total) {
      throw new Error('PDF_NO_TEXT: the document has no extractable text (it may be a scan)')
    }
    const chunks = buildChunks(pages)
    if (!chunks.length) throw new Error('PDF_NO_TEXT: the document has no extractable text')
    const id = crypto.randomBytes(8).toString('hex')
    const baseName = String(fileName ?? '').replace(/\.pdf$/i, '').trim()
    const doc = {
      id,
      hash,
      title: (extracted.title || baseName || 'Untitled document').slice(0, 200),
      fileName: String(fileName ?? '').slice(0, 260),
      createdAt: new Date().toISOString(),
      pageCount: pages.length,
      chunkCount: chunks.length,
      charCount: total,
      pages,
      chunks,
    }
    await fs.mkdir(this.docsDir, { recursive: true })
    await fs.writeFile(path.join(this.docsDir, `${id}.json`), JSON.stringify(doc), 'utf8')
    index.documents.push({
      id: doc.id,
      hash: doc.hash,
      title: doc.title,
      fileName: doc.fileName,
      createdAt: doc.createdAt,
      pageCount: doc.pageCount,
      chunkCount: doc.chunkCount,
      charCount: doc.charCount,
      preview: excerptOf(chunks[0]?.text ?? '', 160),
    })
    await this.saveIndex()
    this.docCache.set(id, doc)
    this.revision += 1
    return this.summaryOf(doc)
  }

  /** Remove a document and its chunks. */
  async remove(id) {
    const index = await this.loadIndex()
    const at = index.documents.findIndex(doc => doc.id === id)
    if (at < 0) return false
    index.documents.splice(at, 1)
    await this.saveIndex()
    this.docCache.delete(id)
    await fs.rm(path.join(this.docsDir, `${id}.json`), { force: true })
    this.revision += 1
    return true
  }

  /** Public metadata shape for one index entry (no page text). */
  summaryOfInIndex(entry) {
    return {
      id: entry.id,
      title: entry.title,
      fileName: entry.fileName,
      createdAt: entry.createdAt,
      pageCount: entry.pageCount,
      chunkCount: entry.chunkCount,
      charCount: entry.charCount,
      preview: entry.preview,
    }
  }

  /** Public metadata shape (no page text). */
  summaryOf(doc) {
    return {
      id: doc.id,
      title: doc.title,
      fileName: doc.fileName,
      createdAt: doc.createdAt,
      pageCount: doc.pageCount,
      chunkCount: doc.chunkCount,
      charCount: doc.charCount,
      preview: excerptOf(doc.chunks?.[0]?.text ?? doc.pages?.[0] ?? '', 160),
    }
  }

  /** Full record of one document: pages and chunks. */
  async document(id) {
    const doc = await this.loadDocument(id)
    return {
      ...this.summaryOf(doc),
      pages: doc.pages.map((text, index) => ({ page: index + 1, text })),
      chunks: doc.chunks,
    }
  }

  /** Every chunk of every document, used by the knowledge browser. */
  async allChunks() {
    const docs = await this.list()
    const out = []
    for (const meta of docs) {
      const doc = await this.loadDocument(meta.id).catch(() => undefined)
      if (!doc) continue
      out.push(...doc.chunks.map(chunk => ({ ...chunk, documentId: doc.id, document: doc.title })))
    }
    return out
  }

  /** Cached tokenised chunk table across all documents, rebuilt on change. */
  async buildTable() {
    if (this.table && this.tableRevision === this.revision) return this.table
    const docs = await this.list()
    const rows = []
    for (const meta of docs) {
      const doc = await this.loadDocument(meta.id).catch(() => undefined)
      if (!doc) continue
      for (const chunk of doc.chunks) {
        const tokens = tokenize(chunk.text)
        const counts = new Map()
        for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
        rows.push({
          documentId: doc.id,
          document: doc.title,
          page: chunk.page,
          id: chunk.id,
          text: chunk.text,
          counts,
          length: tokens.length,
        })
      }
    }
    const df = new Map()
    for (const row of rows) for (const token of row.counts.keys()) df.set(token, (df.get(token) ?? 0) + 1)
    this.table = { rows, df, total: rows.length, avgLength: rows.length ? rows.reduce((sum, row) => sum + row.length, 0) / rows.length : 0 }
    this.tableRevision = this.revision
    return this.table
  }

  /**
   * Rank chunks for a question.
   * @returns ranked passages plus whether enough of the question was covered.
   */
  async search(question, limit = 5) {
    const terms = [...new Set(tokenize(String(question ?? '')))]
    const table = await this.buildTable()
    if (!terms.length || !table.total) return { hits: [], coverage: 0, matched: [] }
    const idf = new Map()
    for (const term of terms) {
      const freq = table.df.get(term) ?? 0
      idf.set(term, Math.log(1 + (table.total - freq + 0.5) / (freq + 0.5)))
    }
    const scored = []
    for (const row of table.rows) {
      let score = 0
      let matched = 0
      for (const term of terms) {
        const freq = row.counts.get(term)
        if (!freq) continue
        matched += 1
        const norm = 1 - B + B * (row.length / (table.avgLength || 1))
        score += idf.get(term) * ((freq * (K1 + 1)) / (freq + K1 * norm))
      }
      if (score > 0) scored.push({ row, score, matched })
    }
    scored.sort((a, b) => b.score - a.score)
    const best = scored[0]
    const coverage = best ? best.matched / terms.length : 0
    const hasPhrase = best ? best.row.text.replace(/\s+/g, '').includes(String(question).replace(/\s+/g, '')) : false
    const hits = scored.slice(0, limit).map(({ row, score }) => ({
      documentId: row.documentId,
      document: row.document,
      page: row.page,
      chunkId: row.id,
      score: Number(score.toFixed(3)),
      excerpt: excerptOf(row.text),
      text: row.text,
    }))
    return { hits, coverage, matched: terms.filter(term => best?.row.counts.has(term)), hasPhrase, bestScore: best?.score ?? 0 }
  }

  /** Extractively answer a question from the library. */
  async answer(question, limit = 4) {
    const result = await this.search(question, limit)
    const relevant = result.coverage >= MIN_COVERAGE || result.hasPhrase
    if (!result.hits.length || !relevant) {
      return {
        question,
        answer: '',
        missing: true,
        coverage: Number(result.coverage.toFixed(2)),
        matched: result.matched,
        sources: result.hits.slice(0, 3).map(({ text, ...rest }) => rest),
      }
    }
    const terms = new Set(tokenize(String(question ?? '')))
    const sentences = []
    for (const hit of result.hits.slice(0, 3)) {
      for (const sentence of splitSentences(hit.text)) {
        let score = 0
        for (const term of tokenize(sentence)) if (terms.has(term)) score += 1
        if (!score) continue
        sentences.push({ sentence, score: score / Math.sqrt(sentence.length), document: hit.document, page: hit.page })
      }
    }
    sentences.sort((a, b) => b.score - a.score)
    const picked = sentences.slice(0, 4)
    if (!picked.length) {
      return {
        question,
        answer: '',
        missing: true,
        coverage: Number(result.coverage.toFixed(2)),
        matched: result.matched,
        sources: result.hits.slice(0, 3).map(({ text, ...rest }) => rest),
      }
    }
    const answer = picked.map(({ sentence, document, page }) => `${sentence.trim()} [${document} · p.${page}]`).join('\n')
    return {
      question,
      answer,
      missing: false,
      coverage: Number(result.coverage.toFixed(2)),
      matched: result.matched,
      sources: result.hits.map(({ text, ...rest }) => rest),
    }
  }
}
