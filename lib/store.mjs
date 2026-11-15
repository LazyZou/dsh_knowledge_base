/**
 * PDF knowledge base storage and retrieval.
 *
 * Documents live under `<dataDir>/docs/<id>.json` and are summarised in
 * `<dataDir>/index.json`. Retrieval is BM25 over overlapping page chunks; the
 * panel answer is extractive so it can never invent facts from outside the
 * library, which is what lets the UI report a missing topic honestly.
 *
 * A page whose text layer is empty is a scan. Its painted image is stored under
 * `<dataDir>/docs/<id>/` and the page starts as pending OCR work, so importing a
 * scanned PDF succeeds and the text arrives when recognition runs.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { extractPdfText, readPageImage } from './pdf.mjs'
import { CHUNK_VERSION, buildChunks, cleanPageText, topicSummary } from './clean.mjs'

/** Fraction of the query terms a chunk must match to count as relevant. */
const MIN_COVERAGE = 0.34
/** Widest raster sent to the vision model; bigger pages are reduced to save recognition tokens. */
const PAGE_IMAGE_MAX_WIDTH = 1600
/** A page shorter than this is treated as a scan that needs OCR. */
const MIN_TEXT_CHARS = 24
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

/** Page text including recognized OCR text, in page order. */
function effectivePages(doc) {
  return doc.pages.map((text, index) => {
    if (text.trim().length >= MIN_TEXT_CHARS) return text
    const recognized = doc.ocr?.[index + 1]?.text ?? ''
    return recognized.trim() ? recognized : text
  })
}

/**
 * Rebuild a document's knowledge from its pages with the current cleaner.
 * Called on import, after every recognition, and when an older document is
 * opened so a better cleaner also improves what is already stored.
 */
function refreshKnowledge(doc) {
  doc.chunks = buildChunks(effectivePages(doc), { title: doc.title })
  doc.chunkCount = doc.chunks.length
  doc.topics = topicSummary(doc.chunks)
  doc.chunksVersion = CHUNK_VERSION
  return doc
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

/** Pages still waiting for recognition. */
function pendingPages(doc) {
  const out = []
  for (const [key, entry] of Object.entries(doc.ocr ?? {})) {
    if (entry.status === 'pending' || entry.status === 'failed') out.push(Number(key))
  }
  return out.sort((a, b) => a - b)
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
      this.index = { version: 2, documents: Array.isArray(parsed.documents) ? parsed.documents : [] }
    } catch {
      this.index = { version: 2, documents: [] }
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
    // Documents stored by an older cleaner are rebuilt on first use, so the
    // knowledge browser and the index never show text this version rejects.
    if (doc.chunksVersion !== CHUNK_VERSION) {
      refreshKnowledge(doc)
      await this.writeDocument(doc)
      await this.syncIndexEntry(doc)
    }
    return doc
  }

  /** Refresh the index row of one document after its knowledge changed. */
  async syncIndexEntry(doc) {
    const index = await this.loadIndex()
    const entry = index.documents.find(item => item.id === doc.id)
    if (!entry) return
    entry.chunkCount = doc.chunkCount
    entry.charCount = doc.charCount
    entry.ocrPending = pendingPages(doc).length
    entry.chunkVersion = doc.chunksVersion
    entry.topics = (doc.topics ?? []).map(topic => ({ name: topic.name, chunkCount: topic.chunkCount }))
    entry.preview = excerptOf(doc.chunks[0]?.text ?? '', 160)
    await this.saveIndex()
  }

  /** Persist one document file and refresh the cached copy. */
  async writeDocument(doc) {
    await fs.mkdir(this.docsDir, { recursive: true })
    await fs.writeFile(path.join(this.docsDir, `${doc.id}.json`), JSON.stringify(doc), 'utf8')
    this.docCache.set(doc.id, doc)
  }

  /** Metadata for every stored document, newest first. */
  async list() {
    const index = await this.loadIndex()
    return [...index.documents].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  /**
   * Parse, chunk, and store one PDF upload.
   * A scan keeps its pages as pending OCR work instead of failing outright.
   */
  async add({ buffer, fileName }) {
    const hash = crypto.createHash('sha1').update(buffer).digest('hex')
    const index = await this.loadIndex()
    const existing = index.documents.find(entry => entry.hash === hash)
    if (existing) return { ...this.summaryOfInIndex(existing), duplicate: true }
    const extracted = extractPdfText(buffer)
    const pages = extracted.pages
    const id = crypto.randomBytes(8).toString('hex')
    const images = {}
    const ocr = {}
    let stored = 0
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].trim().length >= MIN_TEXT_CHARS) continue
      const meta = extracted.images?.[i]
      if (!meta) continue
      let decoded
      let vision
      try {
        decoded = readPageImage(buffer, meta)
        // Tesseract reads the full raster (sharper glyphs = fewer mistakes);
        // the vision model gets a reduced copy to keep recognition tokens low.
        vision = decoded && decoded.mediaType === 'image/png'
          ? readPageImage(buffer, meta, { maxWidth: PAGE_IMAGE_MAX_WIDTH })
          : undefined
      } catch {
        decoded = undefined
        vision = undefined
      }
      if (!decoded) continue
      const extension = decoded.mediaType === 'image/jpeg' ? 'jpg' : 'png'
      const relative = path.join(id, `p${i + 1}.${extension}`)
      const absolute = path.join(this.docsDir, relative)
      await fs.mkdir(path.dirname(absolute), { recursive: true })
      await fs.writeFile(absolute, decoded.bytes)
      const entry = {
        file: relative.split(path.sep).join('/'),
        mediaType: decoded.mediaType,
        width: meta.width,
        height: meta.height,
        bytes: decoded.bytes.length,
      }
      if (vision && vision.bytes.length && (vision.width !== decoded.width || vision.height !== decoded.height)) {
        const visionRelative = path.join(id, `p${i + 1}.vision.png`)
        await fs.writeFile(path.join(this.docsDir, visionRelative), vision.bytes)
        entry.visionFile = visionRelative.split(path.sep).join('/')
        entry.visionWidth = vision.width
        entry.visionHeight = vision.height
      }
      images[i + 1] = entry
      ocr[i + 1] = { status: 'pending' }
      stored += 1
    }
    const total = pages.reduce((sum, page) => sum + page.trim().length, 0)
    if (!total && !stored) {
      throw new Error('PDF_NO_TEXT: the document has no extractable text and no page image to recognize')
    }
    const baseName = String(fileName ?? '').replace(/\.pdf$/i, '').trim()
    const doc = {
      id,
      hash,
      title: (extracted.title || baseName || 'Untitled document').slice(0, 200),
      fileName: String(fileName ?? '').slice(0, 260),
      createdAt: new Date().toISOString(),
      pageCount: pages.length,
      chunkCount: 0,
      charCount: total,
      scanned: stored > 0,
      ocr,
      images,
      pages,
    }
    refreshKnowledge(doc)
    await this.writeDocument(doc)
    index.documents.push({
      id: doc.id,
      hash: doc.hash,
      title: doc.title,
      fileName: doc.fileName,
      createdAt: doc.createdAt,
      pageCount: doc.pageCount,
      chunkCount: doc.chunkCount,
      charCount: doc.charCount,
      scanned: doc.scanned,
      ocrPending: pendingPages(doc).length,
      chunkVersion: doc.chunksVersion,
      topics: doc.topics.map(topic => ({ name: topic.name, chunkCount: topic.chunkCount })),
      preview: excerptOf(doc.chunks[0]?.text ?? '', 160),
    })
    await this.saveIndex()
    this.revision += 1
    return this.summaryOf(doc)
  }

  /** Remove a document and its chunks and page images. */
  async remove(id) {
    const index = await this.loadIndex()
    const at = index.documents.findIndex(doc => doc.id === id)
    if (at < 0) return false
    index.documents.splice(at, 1)
    await this.saveIndex()
    this.docCache.delete(id)
    await fs.rm(path.join(this.docsDir, `${id}.json`), { force: true })
    await fs.rm(path.join(this.docsDir, id), { recursive: true, force: true })
    this.revision += 1
    return true
  }

  /** Pages that still need recognition, with the stored image path. */
  async pendingOcr(id, limit = 8) {
    const doc = await this.loadDocument(id)
    return pendingPages(doc)
      .filter(page => doc.images?.[page]?.file)
      .slice(0, limit)
      .map(page => ({
        page,
        path: path.join(this.docsDir, doc.images[page].file),
        visionPath: doc.images[page].visionFile ? path.join(this.docsDir, doc.images[page].visionFile) : undefined,
        mediaType: doc.images[page].mediaType,
        width: doc.images[page].width,
        height: doc.images[page].height,
      }))
  }

  /** Absolute path of one stored page image. */
  async pageImage(id, page) {
    const doc = await this.loadDocument(id)
    const entry = doc.images?.[page]
    if (!entry?.file) return undefined
    return { path: path.join(this.docsDir, entry.file), mediaType: entry.mediaType }
  }

  /** Record recognized text for one page and rebuild that document's chunks. */
  async applyOcr(id, page, text, engine) {
    const doc = await this.loadDocument(id)
    if (!doc.ocr) doc.ocr = {}
    const clean = String(text ?? '').trim()
    doc.ocr[page] = { status: 'done', text: clean, engine: engine ?? 'unknown', updatedAt: new Date().toISOString() }
    doc.charCount = effectivePages(doc).reduce((sum, pageText) => sum + pageText.trim().length, 0)
    refreshKnowledge(doc)
    await this.writeDocument(doc)
    this.revision += 1
    await this.syncIndexEntry(doc)
    return { page, chars: clean.length, engine }
  }

  /** Record a failed recognition attempt so the panel can offer a retry. */
  async failOcr(id, page, message) {
    const doc = await this.loadDocument(id)
    if (!doc.ocr) doc.ocr = {}
    doc.ocr[page] = { status: 'failed', message: String(message ?? '').slice(0, 300) }
    await this.writeDocument(doc)
    const index = await this.loadIndex()
    const entry = index.documents.find(item => item.id === id)
    if (entry) {
      entry.ocrPending = pendingPages(doc).length
      await this.saveIndex()
    }
    return { page, message }
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
      scanned: entry.scanned === true,
      ocrPending: entry.ocrPending ?? 0,
      topicCount: (entry.topics ?? []).length,
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
      scanned: doc.scanned === true || Object.keys(doc.ocr ?? {}).length > 0,
      ocrPending: pendingPages(doc).length,
      topicCount: (doc.topics ?? []).length,
      preview: excerptOf(doc.chunks?.[0]?.text ?? doc.pages?.[0] ?? '', 160),
    }
  }

  /** Full record of one document: pages and chunks. */
  async document(id) {
    const doc = await this.loadDocument(id)
    const texts = effectivePages(doc)
    return {
      ...this.summaryOf(doc),
      pages: texts.map((text, index) => ({
        page: index + 1,
        text: cleanPageText(text),
        ocrStatus: doc.ocr?.[index + 1]?.status ?? 'none',
        hasImage: Boolean(doc.images?.[index + 1]),
        ocrEngine: doc.ocr?.[index + 1]?.engine,
        ocrChars: (doc.ocr?.[index + 1]?.text ?? '').length,
      })),
      topics: doc.topics ?? [],
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
          topic: chunk.topic ?? '',
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
      topic: row.topic,
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
