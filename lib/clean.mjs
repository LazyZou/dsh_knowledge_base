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
export const CHUNK_VERSION = 6

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
const DECORATION_MIXED = /^[\s\-_=*…\.。、,，|+/\\<>()\[\]{}]+$/u
/** Dotted leaders of a table of contents: "18.9 图算法的分析 ..... 103". */
const LEADER_LINE = /(?:\.\s*){4,}|·{3,}|…{2,}|_{4,}/u
/** A run of letters with almost no variety: OCR noise where a leader line was. */
function isGibberishToken(token) {
  const letters = token.replace(/[^\p{L}]/gu, '')
  if (letters.length < 8) return false
  const distinct = new Set(letters.toLowerCase()).size
  if (distinct / letters.length <= 0.3) return true
  // A long ASCII run without any vowel is not a word in any Latin alphabet.
  return !/[aeiouy]/i.test(letters)
}

/** A table-of-contents row whose leader collapsed into dots and a page number. */
const TOC_TAIL = /\.{2,}\s*\d{1,4}\s*$/u

/** True when a line looks like OCR noise or a table-of-contents row. */
export function isGarbageLine(line) {
  const text = normalizeLine(line)
  if (!text) return true
  if (LEADER_LINE.test(text) || TOC_TAIL.test(text)) return true
  // Judge only the Latin tokens: Chinese runs are always legitimate text.
  const tokens = text.split(/\s+/).filter(token => !CJK.test(token))
  if (!tokens.length) return false
  // OCR turns a dot leader into the same two syllables over and over:
  // "eee eee reer rere reer rerrerirrr". Real prose repeats far less.
  if (tokens.length >= 8) {
    const distinct = new Set(tokens.map(token => token.toLowerCase()))
    if (distinct.size / tokens.length < 0.5) return true
  }
  const bad = tokens.filter(isGibberishToken)
  if (!bad.length) return false
  const letters = count => count.replace(/[^\p{L}]/gu, '').length
  const badShare = letters(bad.join('')) / Math.max(1, letters(tokens.join('')))
  return badShare >= 0.25
}

/** True when a line is page furniture or decoration rather than prose. */
export function isNoiseLine(line) {
  const text = normalizeLine(line)
  if (!text) return true
  if (text.length < 2) return true
  if (DECORATION.test(text.replace(/\s+/g, ''))) return true
  if (DECORATION_MIXED.test(text)) return true
  if (PAGE_FURNITURE.some(pattern => pattern.test(text))) return true
  if (isGarbageLine(text)) return true
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
  if (!text || text.length > 40) return undefined
  if (/[。；;!?！？，,、]$/u.test(text)) return undefined
  // A run-on sentence that merely starts with "第 19 章" describes the chapter,
  // it does not title it; real headings have no clause punctuation inside.
  if (/[，、；：。！？]/u.test(text)) return undefined
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
/** A contents row: a short label that ends in a page number. */
const TOC_ENTRY = /\d{1,4}\s*$/u

/**
 * A page that is mostly short rows ending in page numbers is a table of
 * contents: it repeats titles that appear again in the body, so indexing it
 * only adds noise. The panel's page view still shows it.
 */
function isTocPage(lines) {
  if (lines.length < 4) return false
  const average = lines.reduce((sum, line) => sum + line.text.length, 0) / lines.length
  if (average > 60) return false
  const rows = lines.filter(line => TOC_ENTRY.test(line.text)).length
  return rows / lines.length >= 0.6
}

export function prepareLines(pages, options = {}) {
  const lines = []
  const skipToc = options.skipTocPages === true
  let previous = ''
  pages.forEach((pageText, index) => {
    const page = index + 1
    const kept = []
    for (const raw of String(pageText ?? '').split('\n')) {
      const text = normalizeLine(raw)
      if (!text || isNoiseLine(text)) continue
      // Repeated headers and footers appear once per page; keep the first copy.
      if (text === previous) continue
      previous = text
      kept.push({ page, text })
    }
    if (skipToc && isTocPage(kept)) return
    lines.push(...kept)
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
 * Collapse every spelling of one heading into a stable key.
 *
 * A running header repeats the chapter name on most pages, OCR spells it a
 * little differently each time ("第 19 章 AHA DAG" / "第 19 章 _ 有向图和 DAG"),
 * and section numbers survive OCR even when the title does not. Grouping by the
 * number therefore beats grouping by the text.
 */
export function topicKeyOf(heading) {
  const chapter = /^第\s*([0-9一二三四五六七八九十百零〇]{1,4})\s*[章节節篇讲课]/u.exec(heading)
  if (chapter) return `chapter:${chapter[1]}`
  const section = /^([0-9]{1,2}(?:\.[0-9]{1,2}){1,3})/.exec(heading)
  if (section) return `section:${section[1]}`
  return `text:${heading.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase()}`
}

/** Drop the marks OCR sprinkles around a repeated heading. */
function displayTopic(label) {
  return label
    .replace(/[“”「」『』]/gu, '')
    .replace(/_/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Build topic-aware chunks from page texts.
 *
 * `options.title` is the fallback topic for documents without any heading, so
 * every chunk answers "which part of the library does this come from".
 */
export function buildChunks(pages, options = {}) {
  const lines = prepareLines(pages, { skipTocPages: true })
  const chunks = []
  let topicKey = ''
  let buffer = []
  let bufferLength = 0
  let chunkPage = 0
  let pageEnd = 0
  // key -> (label -> how often that spelling occurred)
  const topics = new Map()

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
        topicKey,
        topic: '',
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
      const key = topicKeyOf(heading)
      const label = displayTopic(heading)
      let variants = topics.get(key)
      if (!variants) {
        variants = new Map()
        topics.set(key, variants)
      }
      variants.set(label, (variants.get(label) ?? 0) + 1)
      topicKey = key
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

  // Name every topic after its most common spelling, so a garbled first sighting
  // does not become the label shown in the panel.
  const labels = new Map()
  topics.forEach((variants, key) => {
    let best = ''
    let bestCount = -1
    variants.forEach((count, label) => {
      if (count > bestCount || (count === bestCount && label.length < best.length)) {
        best = label
        bestCount = count
      }
    })
    labels.set(key, best)
  })

  chunks.forEach(chunk => {
    chunk.topic = labels.get(chunk.topicKey) ?? ''
    delete chunk.topicKey
  })
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
