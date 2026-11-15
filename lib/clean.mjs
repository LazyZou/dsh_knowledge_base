/**
 * Text cleaning and topic grouping for the knowledge base.
 *
 * PDF text layers and OCR both leak noise: decorative rules, page furniture,
 * broken glyphs from missing font maps, and one-character "lines" left behind
 * by a table. Storing that noise wastes retrieval slots and makes the knowledge
 * browser unreadable, so every page goes through `prepareLines()` first and a
 * chunk is only kept when it still carries enough prose to be worth indexing.
 *
 * Chunks also carry the section title they belong to. `buildChunks()` walks the
 * document in order and remembers the last heading it saw, so the panel can
 * group knowledge by topic instead of showing one long flat list.
 */

/** Chunk size in characters; large enough to keep a paragraph's context. */
export const CHUNK_SIZE = 900
/** Overlap in characters between neighbouring chunks. */
export const CHUNK_OVERLAP = 120
/** A chunk with fewer meaningful characters than this is noise, not knowledge. */
export const MIN_CHUNK_CHARS = 32
/** Chunk list version, so stored documents can be rebuilt when cleaning improves. */
export const CHUNK_VERSION = 2

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u
const ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff\u00ad]/g
const PRIVATE_USE = /[\ue000-\uf8ff\ufffd]/g
/** Control characters a PDF text layer sometimes contains; newlines are kept. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

/** Remove characters that never belong in stored knowledge. */
export function stripControl(text) {
  return String(text ?? '')
    .replace(ZERO_WIDTH, '')
    .replace(PRIVATE_USE, '')
    .replace(CONTROL, '')
}

/** Collapse spacing inside one line without touching line breaks. */
export function normalizeLine(text) {
  return stripControl(text)
    .replace(/[\u00a0\u2000-\u200a\u3000]/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/** How many letters, digits or CJK characters a line really carries. */
export function meaningfulLength(text) {
  let count = 0
  for (const char of String(text ?? '')) {
    if (LETTER_OR_DIGIT.test(char) || CJK.test(char)) count += 1
  }
  return count
}

const PAGE_FURNITURE = [
  /^[-–—\s]*(?:第\s*)?\d{1,4}(?:\s*页)?[-–—\s]*$/u,
  /^page\s*\d+(?:\s*(?:of|\/)\s*\d+)?$/iu,
  /^\d{1,4}\s*\/\s*\d{1,4}$/u,
  /^\d{1,4}\s*of\s*\d{1,4}$/iu,
]
/** A rule made of one repeated decoration glyph: -----, ====, ·····, 。。。。 */
const DECORATION = /^([^\p{L}\p{N}])\1{2,}$/u
const DECORATION_MIXED = /^[\s\-_=*~#·•—–…\.。、,，|+/\\<>()\[\]{}]+$/u

/** True when a line is page furniture or decoration rather than prose. */
export function isNoiseLine(line) {
  const text = normalizeLine(line)
  if (!text) return true
  if (text.length < 2) return true
  if (DECORATION.test(text.replace(/\s+/g, ''))) return true
  if (DECORATION_MIXED.test(text)) return true
  if (PAGE_FURNITURE.some(pattern => pattern.test(text))) return true
  const compact = text.replace(/\s+/g, '')
  const letters = meaningfulLength(compact)
  // Lines that are mostly punctuation or stray glyphs are broken text layers.
  if (compact.length >= 4 && letters / compact.length < 0.35) return true
  return false
}

const HEADING_RULES = [
  /^第\s*[0-9一二三四五六七八九十百零〇]{1,4}\s*[章节節部分篇讲课]/u,
  /^(?:chapter|section|part|appendix)\s+[0-9ivxlc]+\b/iu,
  // At least two numeric levels, so "9. jdbc.driver=..." stays body text.
  /^[0-9]{1,2}(?:\.[0-9]{1,2}){1,3}\s+\S/u,
  /^[一二三四五六七八九十]{1,3}[、.]\s*\S/u,
]
/** Characters that mean a line is code or a config entry, never a section title. */
const CODE_LIKE = /[={};"'<>]|\/\/|\|\|/u

/**
 * Section title for a line, or undefined when the line is body text.
 *
 * Headings are short, unpunctured and free of code punctuation; a numbered list
 * item or a line of Java would otherwise open a topic of its own and scatter the
 * knowledge across hundreds of one-chunk groups.
 */
export function headingTitle(line, next) {
  const text = normalizeLine(line)
  if (!text || text.length > 60) return undefined
  if (/[。；;!?！？，,]$/u.test(text)) return undefined
  if (CODE_LIKE.test(text)) return undefined
  const compact = text.replace(/\s+/g, '')
  if (meaningfulLength(compact) / compact.length < 0.6) return undefined
  if (!HEADING_RULES.some(pattern => pattern.test(text))) return undefined
  // A heading introduces something; a body line rarely stands alone.
  const follower = normalizeLine(next ?? '')
  if (follower && follower.length < text.length && follower.length < 40) return undefined
  return text
}

/**
 * Turn raw page texts into the ordered line stream used for chunking.
 * Page numbers are 1-based, matching what the panel shows.
 */
export function prepareLines(pages) {
  const lines = []
  let previous = ''
  pages.forEach((pageText, index) => {
    const page = index + 1
    for (const raw of String(pageText ?? '').split('\n')) {
      const text = normalizeLine(raw)
      if (!text || isNoiseLine(text)) continue
      // Repeated headers and footers appear once per page; keep the first copy.
      if (text === previous) continue
      previous = text
      lines.push({ page, text })
    }
  })
  return lines
}

/** Join lines back into a chunk body while keeping paragraph breaks readable. */
function joinLines(lines) {
  return lines
    .map(line => line.text)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A heading-only chunk carries no answer, so it is merged into what follows. */
function isSubstantial(text) {
  return meaningfulLength(text) >= MIN_CHUNK_CHARS
}

/**
 * Build topic-aware chunks from page texts.
 *
 * `options.title` is the fallback topic for documents without any heading, so
 * every chunk answers "which part of the library does this come from".
 */
export function buildChunks(pages, options = {}) {
  const lines = prepareLines(pages)
  const chunks = []
  let topic = ''
  let buffer = []
  let bufferLength = 0
  let chunkPage = 0
  let pageEnd = 0

  const flush = (force = false) => {
    if (!buffer.length) return
    const text = joinLines(buffer)
    // A forced flush may emit a short section, but never a bare heading.
    const enough = force ? meaningfulLength(text) >= 8 : isSubstantial(text)
    if (text && enough) {
      chunks.push({
        id: '',
        page: chunkPage,
        pageEnd: pageEnd || chunkPage,
        topic,
        text,
      })
    }
    // Carry a little context into the next chunk, aligned to whole lines.
    const carry = []
    let carried = 0
    for (let i = buffer.length - 1; i >= 0 && carried < CHUNK_OVERLAP; i -= 1) {
      carry.unshift(buffer[i])
      carried += buffer[i].text.length
    }
    buffer = carry.length === buffer.length ? [] : carry
    bufferLength = buffer.reduce((sum, line) => sum + line.text.length + 1, 0)
    if (buffer.length) {
      chunkPage = buffer[0].page
      pageEnd = buffer[buffer.length - 1].page
    }
  }

  lines.forEach((line, index) => {
    const heading = headingTitle(line.text, lines[index + 1]?.text)
    if (heading) {
      // A heading opens a topic; the text before it belongs to the old one.
      flush(true)
      topic = heading
    }
    if (!buffer.length) {
      chunkPage = line.page
      pageEnd = line.page
    }
    buffer.push(line)
    bufferLength += line.text.length + 1
    pageEnd = line.page
    if (bufferLength >= CHUNK_SIZE) flush()
  })
  flush(true)

  if (!chunks.some(chunk => chunk.topic)) {
    assignKeywordTopics(chunks, options.title)
  }
  chunks.forEach((chunk, index) => {
    chunk.id = `${chunk.page}-${index + 1}`
    if (!chunk.topic) chunk.topic = options.title || ''
  })
  return chunks
}

/** Common words that make useless topic names. */
const STOP_TERMS = new Set([
  'this', 'that', 'with', 'from', 'have', 'will', 'which', 'there', 'their', 'they', 'than',
  'then', 'when', 'what', 'were', 'been', 'some', 'such', 'into', 'more', 'most', 'also',
  '使用', '可以', '我们', '这个', '因此', '如果', '就是', '这样', '没有', '一个', '这些',
  '因为', '所以', '但是', '而且', '不是', '已经', '通过', '进行', '以及', '对于',
])

/** Terms describing a chunk: ASCII words and CJK bigrams, stop words removed. */
function termsOf(text) {
  const terms = new Map()
  const lowered = String(text ?? '').toLowerCase()
  const words = lowered.match(/[a-z][a-z0-9_-]{2,}/g) ?? []
  for (const word of words) {
    if (STOP_TERMS.has(word)) continue
    terms.set(word, (terms.get(word) ?? 0) + 1)
  }
  const cjkRuns = lowered.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{2,}/g) ?? []
  for (const run of cjkRuns) {
    for (let i = 0; i + 1 < run.length; i += 1) {
      const bigram = run.slice(i, i + 2)
      if (STOP_TERMS.has(bigram)) continue
      terms.set(bigram, (terms.get(bigram) ?? 0) + 1)
    }
  }
  return terms
}

/**
 * Fallback grouping for documents without headings: name each chunk after the
 * term it repeats most often, and leave genuinely unrepeated text as "other".
 * Only a handful of terms survive, so the panel gets a few real topics instead
 * of hundreds of one-chunk labels.
 */
export function assignKeywordTopics(chunks, fallbackTitle) {
  if (!chunks.length) return
  const documentFrequency = new Map()
  const perChunk = chunks.map(chunk => {
    const terms = termsOf(chunk.text)
    for (const term of terms.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
    return terms
  })
  const minFrequency = Math.max(2, Math.round(chunks.length * 0.08))
  const shared = [...documentFrequency.entries()]
    .filter(([, count]) => count >= minFrequency)
    .map(([term]) => term)
    .slice(0, 400)
  if (!shared.length) return

  shared.sort((left, right) => (documentFrequency.get(right) ?? 0) - (documentFrequency.get(left) ?? 0))
  const top = new Set(shared.slice(0, 8))
  chunks.forEach((chunk, index) => {
    if (chunk.topic) return
    const terms = perChunk[index]
    let best = ''
    let bestScore = 0
    for (const [term, count] of terms) {
      if (!top.has(term)) continue
      const score = count * (documentFrequency.get(term) ?? 0)
      if (score > bestScore) {
        best = term
        bestScore = score
      }
    }
    chunk.topic = bestScore >= 2 ? best : fallbackTitle || ''
  })
}

/** Topic rows for the knowledge browser, ordered by first appearance. */
export function topicSummary(chunks) {
  const rows = new Map()
  for (const chunk of chunks) {
    const name = chunk.topic || ''
    const row = rows.get(name) ?? { name, chunkCount: 0, chars: 0, firstPage: chunk.page, lastPage: chunk.pageEnd ?? chunk.page }
    row.chunkCount += 1
    row.chars += chunk.text.length
    row.firstPage = Math.min(row.firstPage, chunk.page)
    row.lastPage = Math.max(row.lastPage, chunk.pageEnd ?? chunk.page)
    rows.set(name, row)
  }
  return [...rows.values()].sort((left, right) => left.firstPage - right.firstPage)
}

/** Keep only lines that survived cleaning; used when showing stored page text. */
export function cleanPageText(text) {
  return prepareLines([text]).map(line => line.text).join('\n')
}
