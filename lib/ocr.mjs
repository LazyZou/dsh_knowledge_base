/**
 * Page-image recognition for scanned PDFs.
 *
 * Two backends, best first:
 *  1. A local Tesseract binary — no tokens, no network, offline.
 *  2. The Vision Router `vision_ocr` tool when that plugin is installed, which
 *     routes the page image to whatever vision model the user configured.
 *
 * Recognition is deliberately page-scoped and cached by the caller: only pages
 * whose text layer is empty are sent, so a normal PDF never pays an OCR cost.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Candidate tesseract locations; the first that exists wins. */
const TESSERACT_CANDIDATES = [
  process.env.TESSERACT_PATH,
  process.env.TESSERACT_EXE,
  'C:/Program Files/Tesseract-OCR/tesseract.exe',
  'C:/Program Files (x86)/Tesseract-OCR/tesseract.exe',
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Tesseract-OCR', 'tesseract.exe'),
  '/usr/bin/tesseract',
  '/usr/local/bin/tesseract',
  '/opt/homebrew/bin/tesseract',
]

/** Run a program and resolve its stdout. */
function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr ?? '').trim().slice(0, 300)
        reject(new Error(detail ? `${error.message} (${detail})` : error.message))
        return
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

async function isFile(target) {
  if (!target) return false
  try {
    const stat = await fs.stat(target)
    return stat.isFile()
  } catch {
    return false
  }
}

/** Locate a usable tesseract once per process. */
let tesseractCache
async function findTesseract(configured) {
  const wanted = typeof configured === 'string' && configured.trim() ? configured.trim() : undefined
  if (tesseractCache !== undefined && !wanted) return tesseractCache
  const candidates = wanted ? [wanted, ...TESSERACT_CANDIDATES] : TESSERACT_CANDIDATES
  for (const candidate of candidates) {
    if (candidate && (await isFile(candidate))) {
      tesseractCache = candidate
      return candidate
    }
  }
  // Fall back to PATH lookup through `tesseract --version`.
  try {
    await execFileAsync('tesseract', ['--version'], { timeout: 8000 })
    tesseractCache = 'tesseract'
    return tesseractCache
  } catch {
    tesseractCache = undefined
    return undefined
  }
}

/** Language packs installed next to the binary, so Chinese OCR actually works. */
const languageCache = new Map()
async function pickLanguage(binary) {
  if (languageCache.has(binary)) return languageCache.get(binary)
  let language = 'eng'
  try {
    const { stdout } = await execFileAsync(binary, ['--list-langs'], { timeout: 15000 })
    const installed = stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => /^[a-z_]+$/.test(line))
    if (installed.includes('chi_sim')) language = installed.includes('eng') ? 'chi_sim+eng' : 'chi_sim'
  } catch {
    // Keep `eng`; the run will still fail loudly if the pack is missing.
  }
  languageCache.set(binary, language)
  return language
}

/** JSON snapshot of a tool result, truncated, for diagnosing empty answers. */
function safeJson(value) {
  try {
    return JSON.stringify(value).slice(0, 4000)
  } catch {
    return String(value).slice(0, 4000)
  }
}

/** Read recognized text from a vision tool result. */
function textOfToolResult(result) {
  if (!result || result.isError) {
    const message = result?.content?.map(block => block?.text ?? '').join(' ').trim()
    throw new Error(message || 'vision_ocr reported an error')
  }
  const value = result.value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      // The vision router reports outages as a successful tool call whose
      // payload is an error object, so `isError` alone is not enough.
      if (parsed && parsed.ok === false) {
        const code = parsed.code ?? 'VISION_FAILED'
        const reason = parsed.reason ?? parsed.message ?? ''
        throw new Error(`${code}${reason ? `: ${reason}` : ''}`)
      }
      if (typeof parsed?.text === 'string') return { text: parsed.text, engine: `vision:${parsed.engine ?? 'unknown'}` }
    } catch (error) {
      if (error?.message && /^[A-Z][A-Z0-9_]+/.test(error.message)) throw error
      return { text: value, engine: 'vision' }
    }
    return { text: '', engine: 'vision' }
  }
  const blocks = Array.isArray(result.content) ? result.content : []
  const text = blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
  return { text, engine: 'vision' }
}

/**
 * Drop answers that only describe the absence of text ("图中没有文字", "no visible
 * text", ...) so a blank page never enters the knowledge base as content.
 * @param {string} text
 * @returns {string} recognized text, or an empty string for a no-text answer
 */
export function stripNonTextAnswer(text) {
  const value = String(text ?? '').trim()
  if (!value) return ''
  if (value.length > 80) return value
  const patterns = [
    /不存在文字|没有(任何)?(可见)?文字|未发现文字|无文字(内容)?|图中没有|图片中没有|无法识别(出)?文字|不能识别/,
    /no (visible |legible |readable )?text|there is no text|contains no text|does not contain (any )?text|unable to (recognize|read)/i,
  ]
  return patterns.some(pattern => pattern.test(value)) ? '' : value
}

/** Flatten an error, its causes, and any partial batch results into one line. */function describeError(error) {
  if (!(error instanceof Error)) return String(error)
  const parts = [`${error.name}: ${error.message}`]
  let cause = error.cause
  for (let depth = 0; cause && depth < 3; depth += 1) {
    const text = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
    parts.push(`cause ${depth + 1}: ${text}`)
    cause = cause instanceof Error ? cause.cause : undefined
  }
  const partial = error.partial?.results
  if (Array.isArray(partial)) {
    for (const item of partial) {
      const result = item?.result
      const detail = result?.error ?? result?.content
      if (detail) parts.push(`partial: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 240)}`)
    }
  }
  return parts.join(' | ')
}

/** Recognize one page image through the Vision Router tool. */
async function ocrWithVisionTool(ctx, imagePath, signal) {
  const tools = ctx.tools
  if (!tools || typeof tools.execute !== 'function') throw new Error('OCR_UNAVAILABLE: the tools service is missing')
  if (typeof tools.get === 'function' && !tools.get('vision_ocr')) {
    throw new Error('vision_ocr is not registered in this composition')
  }
  const call = {
    type: 'tool-call',
    id: `pdfkb-ocr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: 'vision_ocr',
    arguments: JSON.stringify({ image: imagePath, engine: 'vision' }),
  }
  let batch
  try {
    batch = await tools.execute({ calls: [call], signal })
  } catch (error) {
    throw new Error(describeError(error))
  }
  const result = batch?.results?.[0]?.result
  if (result?.isError) throw new Error(`vision_ocr failed: ${typeof result.error === 'string' ? result.error : JSON.stringify(result.error ?? result.content ?? {}).slice(0, 240)}`)
  const parsed = textOfToolResult(result)
  if (!parsed.text) parsed.raw = safeJson(result)
  return parsed
}

const CJK_RANGES = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff'
const CJK_PUNCTUATION = '。，、；：！？）】》」』”’…'

/**
 * Normalize recognized text: CRLF to LF, then drop the spaces that Chinese
 * engines insert between adjacent ideographs and around CJK punctuation.
 * Spaces between latin words are preserved, so mixed lines stay readable.
 */
export function tidyOcrText(input) {
  const normalized = String(input ?? '').replace(/\r\n/g, '\n').trim()
  if (!normalized) return ''
  const between = marker => new RegExp(`(?<=[${CJK_RANGES}])[ \\t]*${marker}[ \\t]*(?=[${CJK_RANGES}])`, 'g')
  return normalized
    .replace(between(','), '，')
    .replace(between(';'), '；')
    .replace(between(':'), '：')
    .replace(between('\\?'), '？')
    .replace(between('!'), '！')
    .replace(between('\\.'), '。')
    .replace(new RegExp(`[ \\t]+(?=[${CJK_PUNCTUATION}])`, 'g'), '')
    .replace(new RegExp(`(?<=[（【《「『“‘])[ \\t]+`, 'g'), '')
    .replace(new RegExp(`(?<=[${CJK_PUNCTUATION}])[ \\t]+(?=[${CJK_RANGES}])`, 'g'), '')
    .replace(new RegExp(`(?<=[${CJK_RANGES}])[ \\t]+(?=[${CJK_RANGES}])`, 'g'), '')
}

/**
 * Recognize one page image.
 * @returns {Promise<{ text: string, engine: string }>}
 */
export async function recognizePageImage(ctx, options) {
  const { imagePath, visionImagePath, engine = 'auto', tesseractPath } = options ?? {}
  // The tool executor reads `signal.aborted` unconditionally, so a missing
  // cancellation signal must fall back to a real, never-aborting one.
  const signal = options?.signal ?? new AbortController().signal
  if (!imagePath) throw new Error('OCR_INVALID: no page image')
  const attempts = []
  const wanted = engine === 'vision' ? ['vision'] : engine === 'tesseract' ? ['tesseract'] : ['tesseract', 'vision']
  for (const backend of wanted) {
    if (signal.aborted) throw new Error('OCR_ABORTED: recognition cancelled')
    try {
      if (backend === 'tesseract') {
        const binary = await findTesseract(tesseractPath)
        if (!binary) {
          attempts.push('tesseract: not installed')
          continue
        }
        const language = await pickLanguage(binary)
        const { stdout } = await execFileAsync(binary, [imagePath, 'stdout', '-l', language, '--psm', '3'], {
          timeout: 180000,
          signal,
          // One thread per process: pages are already recognized in parallel.
          env: { ...process.env, OMP_THREAD_LIMIT: '1' },
        })
        const text = tidyOcrText(stdout)
        // A page Tesseract reads as blank is genuinely blank far more often
        // than it is a Tesseract failure, so treat it as an empty page instead
        // of paying for a vision-model fallback (and waiting out its timeout).
        return { text, engine: text ? `tesseract:${language}` : `tesseract:${language}:empty` }
      }
      const recognized = await ocrWithVisionTool(ctx, visionImagePath || imagePath, signal)
      const text = tidyOcrText(String(recognized.text ?? ''))
      return { text, engine: text ? recognized.engine : `${recognized.engine}:empty` }
    } catch (error) {
      attempts.push(`${backend}: ${describeError(error)}`)
    }
  }
  throw new Error(`OCR_UNAVAILABLE: no recognition backend produced text (${attempts.join('; ') || 'none attempted'})`)
}

/** Whether a local tesseract exists, without running recognition. */
export async function probeTesseract(tesseractPath) {
  const binary = await findTesseract(tesseractPath)
  if (!binary) return { available: false }
  const language = await pickLanguage(binary)
  return { available: true, binary, language }
}
