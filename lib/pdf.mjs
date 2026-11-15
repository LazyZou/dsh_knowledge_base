/**
 * Minimal, dependency-free PDF text extractor.
 *
 * Supports: xref-less indirect object scanning, object streams (/ObjStm),
 * FlateDecode / ASCIIHexDecode / ASCII85Decode content streams, page tree
 * walking, Form XObject recursion, Type0 (Identity) and simple fonts with
 * /ToUnicode CMaps or WinAnsiEncoding fallback.
 *
 * Not supported: LZW/JPX/JBIG2 images; encrypted files need the user
 * password unless they use the empty-password Standard handler.
 */
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { decodeCcitt } from './ccitt.mjs'

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20])

/** True when the byte is PDF whitespace. */
function isWs(c) {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00
}

/** Decode one content stream according to its /Filter chain. */
function decodeStream(raw, dict) {
  const filters = []
  const f = dict.raw('Filter')
  const add = value => {
    if (typeof value !== 'string') return
    const name = value.trim().replace(/^\//, '')
    if (name) filters.push(name)
  }
  if (Array.isArray(f)) {
    for (const item of f) add(item)
  } else {
    add(f)
  }
  let out = raw
  for (const filter of filters) {
    try {
      if (filter === 'FlateDecode' || filter === 'Fl') {
        out = inflate(out)
      } else if (filter === 'ASCIIHexDecode' || filter === 'AHx') {
        out = asciiHex(out)
      } else if (filter === 'ASCII85Decode' || filter === 'A85') {
        out = ascii85(out)
      } else {
        return Buffer.alloc(0)
      }
    } catch {
      return Buffer.alloc(0)
    }
  }
  return out
}

/** zlib inflate that tolerates missing headers and trailing garbage. */
function inflate(buf) {
  const attempts = [
    () => zlib.inflateSync(buf),
    () => zlib.inflateSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH }),
    () => zlib.inflateRawSync(buf),
    () => zlib.inflateRawSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH }),
  ]
  for (const attempt of attempts) {
    try {
      const out = attempt()
      if (out.length) return out
    } catch {
      /* try the next variant */
    }
  }
  return Buffer.alloc(0)
}

/** Decode an ASCIIHexDecode stream. */
function asciiHex(buf) {
  let hex = ''
  for (const byte of buf) {
    if (byte === 0x3e) break
    const ch = String.fromCharCode(byte)
    if (/[0-9a-fA-F]/.test(ch)) hex += ch
  }
  if (hex.length % 2) hex += '0'
  return Buffer.from(hex, 'hex')
}

/** Decode an ASCII85Decode stream. */
function ascii85(buf) {
  const text = buf.toString('latin1')
  const end = text.indexOf('~>')
  const body = (end === -1 ? text : text.slice(0, end)).replace(/^<~/, '').replace(/\s+/g, '')
  const out = []
  let tuple = []
  for (const ch of body) {
    if (ch === 'z' && tuple.length === 0) {
      out.push(0, 0, 0, 0)
      continue
    }
    const code = ch.charCodeAt(0) - 33
    if (code < 0 || code > 84) continue
    tuple.push(code)
    if (tuple.length === 5) {
      let value = 0
      for (const digit of tuple) value = value * 85 + digit
      out.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255)
      tuple = []
    }
  }
  if (tuple.length > 1) {
    while (tuple.length < 5) tuple.push(84)
    let value = 0
    for (const digit of tuple) value = value * 85 + digit
    const bytes = [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]
    out.push(...bytes.slice(0, tuple.length - 1))
  }
  return Buffer.from(out)
}

/** The 32-byte padding string from the PDF standard security handler. */
const PASSWORD_PAD = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
])

/** Pad or truncate a password to the handler's 32-byte form. */
function padPassword(password) {
  const source = Buffer.from(password, 'latin1')
  const out = Buffer.alloc(32)
  let written = 0
  for (let i = 0; i < 32 && i < source.length; i++) out[written++] = source[i]
  for (let i = 0; written < 32; i++) out[written++] = PASSWORD_PAD[i]
  return out
}

/** Derive the file encryption key (Algorithm 2) for revisions 2–4. */
function computeFileKey(ownerEntry, permissions, id0, revision, lengthBits) {
  const size = revision === 2 ? 5 : Math.max(5, Math.min(16, (lengthBits || 40) / 8))
  const p = Buffer.alloc(4)
  p.writeInt32LE(permissions | 0, 0)
  let digest = crypto.createHash('md5')
    .update(Buffer.concat([padPassword(''), ownerEntry, p, id0]))
    .digest()
  if (revision >= 3) {
    for (let i = 0; i < 50; i++) digest = crypto.createHash('md5').update(digest.subarray(0, size)).digest()
  }
  return digest.subarray(0, size)
}

/** Check an empty user password against the /U entry (Algorithm 6). */
function verifyUserKey(fileKey, userEntry, id0, revision) {
  if (!fileKey.length || !userEntry?.length) return false
  if (revision === 2) {
    return rc4(fileKey, PASSWORD_PAD).equals(userEntry.subarray(0, 32))
  }
  let value = rc4(fileKey, crypto.createHash('md5').update(Buffer.concat([PASSWORD_PAD, id0])).digest())
  for (let i = 1; i <= 19; i++) {
    const key = Buffer.from(fileKey.map(byte => byte ^ i))
    value = rc4(key, value)
  }
  return value.equals(userEntry.subarray(0, 16))
}

/** Per-object key from the file key, object number, and generation. */function objectKey(fileKey, num, gen) {
  const suffix = Buffer.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff])
  const digest = crypto.createHash('md5').update(Buffer.concat([fileKey, suffix])).digest()
  return digest.subarray(0, Math.min(fileKey.length + 5, 16))
}

/** RC4 keystream XOR. */
function rc4(key, data) {
  const state = new Uint8Array(256)
  for (let i = 0; i < 256; i++) state[i] = i
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + state[i] + key[i % key.length]) & 0xff
    const swap = state[i]
    state[i] = state[j]
    state[j] = swap
  }
  const out = Buffer.alloc(data.length)
  let i = 0
  j = 0
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff
    j = (j + state[i]) & 0xff
    const swap = state[i]
    state[i] = state[j]
    state[j] = swap
    out[k] = data[k] ^ state[(state[i] + state[j]) & 0xff]
  }
  return out
}

/** Decrypt one object's bytes with RC4 or AES-128-CBC (AESV2). */
function decryptObject(fileKey, num, gen, mode, data) {
  const key = objectKey(fileKey, num, gen)
  if (mode === 'aes') {
    if (data.length < 32) return Buffer.alloc(0)
    const iv = data.subarray(0, 16)
    const body = data.subarray(16, 16 + Math.floor((data.length - 16) / 16) * 16)
    try {
      const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv)
      return Buffer.concat([decipher.update(body), decipher.final()])
    } catch {
      try {
        const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv)
        decipher.setAutoPadding(false)
        const out = Buffer.concat([decipher.update(body), decipher.final()])
        const pad = out[out.length - 1]
        return pad > 0 && pad <= 16 ? out.subarray(0, out.length - pad) : out
      } catch {
        return Buffer.alloc(0)
      }
    }
  }
  return rc4(key, data)
}

/** A parsed PDF dictionary with a raw text form kept for lazy value parsing. */
class Dict {
  constructor(text) {
    this.text = text
    const values = Object.create(null)
    const re = /\/([^\s/<>[\]()%]+)\s*/g
    let match
    while ((match = re.exec(text))) {
      const key = match[1]
      const valueStart = match.index + match[0].length
      values[key] = { start: valueStart, raw: readValueText(text, valueStart) }
      re.lastIndex = valueStart
    }
    this.values = values
  }

  /** Raw textual value of one key, if present. */
  raw(key) {
    const entry = this.values[key]
    return entry ? entry.raw : undefined
  }

  /** Read a direct number, name, or boolean value. */
  scalar(key) {
    const raw = this.raw(key)
    if (raw === undefined) return undefined
    const text = raw.trim()
    if (!text.length) return undefined
    if (text[0] === '/') return text.slice(1)
    if (text === 'true') return true
    if (text === 'false') return false
    const num = Number(text)
    return Number.isFinite(num) ? num : undefined
  }

  /** True when the key's value is a reference to another object. */
  ref(key) {
    const raw = this.raw(key)
    if (raw === undefined) return undefined
    const match = /^\s*(\d+)\s+(\d+)\s+R\b/.exec(raw)
    return match ? { num: Number(match[1]), gen: Number(match[2]) } : undefined
  }

  /** Parse the key's value as an array of references and/or names. */
  array(key) {
    const raw = this.raw(key)
    if (raw === undefined) return []
    const text = raw.trim()
    if (!text.startsWith('[')) return this.ref(key) ? [this.ref(key)] : []
    const out = []
    const re = /(\d+)\s+(\d+)\s+R\b|\/([^\s/<>[\]()%]+)/g
    let match
    while ((match = re.exec(text))) {
      if (match[1] !== undefined) out.push({ num: Number(match[1]), gen: Number(match[2]) })
      else out.push(`/${match[3]}`)
    }
    return out
  }

  /** Resolve a sub-dictionary referenced by the key, if any. */
  dict(key) {
    const raw = this.raw(key)
    if (raw === undefined) return undefined
    const text = raw.trim()
    return text.startsWith('<<') ? new Dict(text) : undefined
  }

  /** True when the dictionary declares the given /Type. */
  isType(name) {
    return this.scalar('Type') === name
  }
}

/** Read one PDF value's textual extent starting at an offset. */
function readValueText(text, start) {
  let i = start
  while (i < text.length && isWs(text.charCodeAt(i))) i++
  if (text.startsWith('<<', i)) {
    let depth = 0
    let j = i
    while (j < text.length) {
      if (text.startsWith('<<', j)) {
        depth += 1
        j += 2
      } else if (text.startsWith('>>', j)) {
        depth -= 1
        j += 2
        if (depth === 0) return text.slice(i, j)
      } else {
        j += 1
      }
    }
    return text.slice(i)
  }
  if (text[i] === '[') {
    let depth = 0
    let j = i
    while (j < text.length) {
      const ch = text[j]
      if (ch === '[') depth += 1
      else if (ch === ']') {
        depth -= 1
        if (depth === 0) return text.slice(i, j + 1)
      } else if (ch === '(') {
        let parens = 1
        j += 1
        while (j < text.length && parens > 0) {
          if (text[j] === '\\') j += 2
          else if (text[j] === '(') {
            parens += 1
            j += 1
          } else if (text[j] === ')') {
            parens -= 1
            j += 1
          } else j += 1
        }
        continue
      }
      j += 1
    }
    return text.slice(i)
  }
  if (text[i] === '(') {
    let depth = 0
    let j = i
    while (j < text.length) {
      const ch = text[j]
      if (ch === '\\') {
        j += 2
        continue
      }
      if (ch === '(') depth += 1
      else if (ch === ')') {
        depth -= 1
        if (depth === 0) return text.slice(i, j + 1)
      }
      j += 1
    }
    return text.slice(i)
  }
  if (text[i] === '/') {
    let j = i + 1
    while (j < text.length && !isWs(text.charCodeAt(j)) && !'/<>[]()'.includes(text[j])) j++
    return text.slice(i, j)
  }
  if (text[i] === '<') {
    const close = text.indexOf('>', i)
    return close === -1 ? text.slice(i) : text.slice(i, close + 1)
  }
  const re = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(text.slice(i))
  if (re) {
    let j = i + re[0].length
    const rest = /^\s+(\d+)\s+R\b/.exec(text.slice(j))
    if (rest) return text.slice(i, j) + rest[0]
    return text.slice(i, j)
  }
  // Fallback: one token.
  let j = i
  while (j < text.length && !isWs(text.charCodeAt(j))) j++
  return text.slice(i, Math.max(j, i + 1))
}

/** The full document model: indirect objects plus lazy stream decoding. */
class PdfDocument {
  constructor(buf) {
    this.buf = buf
    this.text = buf.toString('latin1')
    this.objects = new Map()
    this.trailer = undefined
    this.#scan()
    this.#setupSecurity()
  }

  /** Collect every `n g obj ... endobj` region and every trailer dictionary. */
  #scan() {
    const src = this.text
    const re = /(?:^|[\s>\]])(\d+)\s+(\d+)\s+obj\b/g
    let match
    while ((match = re.exec(src))) {
      const num = Number(match[1])
      const bodyStart = match.index + match[0].length
      const endobj = src.indexOf('endobj', bodyStart)
      const bodyEnd = endobj === -1 ? src.length : endobj
      const body = src.slice(bodyStart, bodyEnd)
      let dictText = body
      let streamStart = -1
      let streamEnd = -1
      const sIndex = body.search(/\bstream\b/)
      if (sIndex !== -1) {
        dictText = body.slice(0, sIndex)
        let dataStart = bodyStart + sIndex + 'stream'.length
        if (src[dataStart] === '\r') dataStart += 1
        if (src[dataStart] === '\n') dataStart += 1
        const esIndex = src.indexOf('endstream', dataStart)
        streamStart = dataStart
        streamEnd = esIndex === -1 ? bodyEnd : esIndex
      }
      const dict = new Dict(dictText)
      this.objects.set(num, { num, gen: Number(match[2]), dict, streamStart, streamEnd })
      re.lastIndex = bodyEnd
    }
    const trailerRe = /trailer\s*(<<[\s\S]*?>>)/g
    while ((match = trailerRe.exec(src))) this.trailer = new Dict(match[1])
    // A PDF 1.5 cross-reference stream also carries the trailer keys.
    if (!this.trailer) {
      for (const object of this.objects.values()) {
        if (object.dict.isType('XRef')) {
          this.trailer = object.dict
          break
        }
      }
    }
  }

  /** Resolve one reference to its object record. */
  get(ref) {
    if (!ref) return undefined
    return this.objects.get(ref.num)
  }

  /** Lazily decode an object stream. */
  #objStmCache = new Map()

  /** All objects that live inside object streams, merged into the object map. */
  #loadObjectStreams() {
    for (const object of [...this.objects.values()]) {
      if (!object.dict.isType('ObjStm')) continue
      if (this.#objStmCache.has(object.num)) continue
      this.#objStmCache.set(object.num, true)
      const data = this.decode(object)
      const count = object.dict.scalar('N') ?? 0
      const first = object.dict.scalar('First') ?? 0
      const header = data.subarray(0, first).toString('latin1').trim()
      const pairs = header.split(/\s+/).map(Number).filter(n => Number.isFinite(n))
      for (let i = 0; i < count && i * 2 + 1 < pairs.length; i++) {
        const num = pairs[i * 2]
        const offset = pairs[i * 2 + 1]
        const nextOffset = i * 2 + 3 < pairs.length ? pairs[i * 2 + 3] : data.length - first
        const body = data.subarray(first + offset, first + nextOffset).toString('latin1')
        if (!this.objects.has(num)) {
          this.objects.set(num, { num, dict: new Dict(body), streamStart: -1, streamEnd: -1 })
        }
      }
    }
  }

  /** Decoded bytes of an object's stream (empty when it has none). */
  decode(object) {
    if (!object || object.streamStart < 0) return Buffer.alloc(0)
    if (object.decoded) return object.decoded
    let raw = this.buf.subarray(object.streamStart, object.streamEnd)
    const security = this.#security
    if (security && object.num !== security.encNum && !object.dict.isType('XRef')) {
      raw = decryptObject(security.key, object.num, object.gen ?? 0, security.mode, raw)
    }
    const filters = object.dict.raw('Filter')
    object.decoded = filters === undefined ? raw : decodeStream(raw, object.dict)
    return object.decoded
  }

  /** Detect the standard security handler and derive the file key. */
  #security

  /** Prepare decryption for an encrypted document with an empty user password. */
  #setupSecurity() {
    const encRef = this.trailer?.ref('Encrypt')
    if (!encRef) return
    const enc = this.get(encRef)
    if (!enc) return
    if ((enc.dict.scalar('Filter') ?? 'Standard') !== 'Standard') {
      throw new Error(`PDF_ENCRYPTED: unsupported security handler ${enc.dict.scalar('Filter')}`)
    }
    const version = enc.dict.scalar('V') ?? 1
    const revision = enc.dict.scalar('R') ?? 2
    if (version >= 5 || revision >= 5) {
      throw new Error('PDF_ENCRYPTED: AES-256 documents are not supported')
    }
    const ownerText = enc.dict.raw('O')
    if (!ownerText?.startsWith('(')) throw new Error('PDF_ENCRYPTED: malformed /O entry')
    const owner = parseLiteralString(ownerText.slice(1, -1))
    const permissions = enc.dict.scalar('P') ?? 0
    const idRaw = this.trailer?.raw('ID') ?? ''
    const idMatch = /<([0-9a-fA-F]+)>/.exec(idRaw)
    const id0 = idMatch ? parseHexString(idMatch[1]) : Buffer.alloc(0)
    const lengthBits = enc.dict.scalar('Length') ?? 40
    let mode = version >= 4 ? 'aes' : 'rc4'
    let cryptDict = enc.dict.dict('CF')
    if (!cryptDict) {
      const cfRef = enc.dict.ref('CF')
      const cfObject = this.get(cfRef)
      cryptDict = cfObject?.dict
    }
    const stdcf = cryptDict?.dict('StdCF')
    const cfm = stdcf?.scalar('CFM')
    if (cfm === 'AESV3') throw new Error('PDF_ENCRYPTED: AES-256 documents are not supported')
    if (cfm === 'AESV2') mode = 'aes'
    else if (cfm === 'RC4' || cfm === 'None') mode = cfm === 'None' ? 'none' : 'rc4'
    const key = computeFileKey(owner, permissions, id0, revision, lengthBits)
    const userText = enc.dict.raw('U')
    const userEntry = userText?.startsWith('(') ? parseLiteralString(userText.slice(1, -1)) : undefined
    if (userEntry && !verifyUserKey(key, userEntry, id0, revision)) {
      throw new Error('PDF_ENCRYPTED: the document requires a password')
    }
    this.#security = { key, mode, encNum: enc.num }
  }

  /** The document catalog dictionary. */
  catalog() {
    this.#loadObjectStreams()
    const rootRef = this.trailer?.ref('Root')
    const root = this.get(rootRef)
    if (root) return root
    for (const object of this.objects.values()) {
      if (object.dict.isType('Catalog')) return object
    }
    return undefined
  }

  /** Page objects in reading order. */
  pages() {
    this.#loadObjectStreams()
    const pages = []
    const seen = new Set()
    const catalog = this.catalog()
    const walk = (ref, inherited, depth) => {
      if (depth > 32) return
      const object = this.get(ref)
      if (!object || seen.has(object.num)) return
      seen.add(object.num)
      const resources = object.dict.dict('Resources') ?? inherited
      const kids = object.dict.raw('Kids')
      if (object.dict.isType('Pages') || (kids !== undefined && !object.dict.isType('Page'))) {
        for (const kid of object.dict.array('Kids')) {
          if (typeof kid === 'object') walk(kid, resources, depth + 1)
        }
        return
      }
      pages.push({ object, resources })
    }
    const pagesRef = catalog?.dict.ref('Pages')
    if (pagesRef) walk(pagesRef, undefined, 0)
    if (!pages.length) {
      for (const object of this.objects.values()) {
        if (object.dict.isType('Page')) {
          pages.push({ object, resources: object.dict.dict('Resources') })
        }
      }
    }
    return pages
  }
}

/** Parse a PDF literal string (the bytes between the parentheses). */
function parseLiteralString(text) {
  const out = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch !== '\\') {
      out.push(text.charCodeAt(i) & 0xff)
      continue
    }
    i += 1
    const next = text[i]
    if (next === undefined) break
    if (next === 'n') out.push(10)
    else if (next === 'r') out.push(13)
    else if (next === 't') out.push(9)
    else if (next === 'b') out.push(8)
    else if (next === 'f') out.push(12)
    else if (next === '(' || next === ')' || next === '\\') out.push(next.charCodeAt(0))
    else if (next === '\r') {
      if (text[i + 1] === '\n') i += 1
    } else if (next === '\n') {
      /* line continuation */
    } else if (/[0-7]/.test(next)) {
      let digits = next
      for (let k = 1; k < 3; k++) {
        if (/[0-7]/.test(text[i + 1] ?? '')) {
          digits += text[i + 1]
          i += 1
        }
      }
      out.push(parseInt(digits, 8) & 0xff)
    } else {
      out.push(next.charCodeAt(0))
    }
  }
  return Buffer.from(out)
}

/** Parse a hex string into bytes. */
function parseHexString(text) {
  let hex = ''
  for (const ch of text) {
    if (/[0-9a-fA-F]/.test(ch)) hex += ch
  }
  if (hex.length % 2) hex += '0'
  return Buffer.from(hex, 'hex')
}

/** Parse one array literal starting just after its `[`, returning items and the end offset. */
function parseArray(text, start) {
  const items = []
  let i = start
  while (i < text.length) {
    const code = text.charCodeAt(i)
    if (isWs(code)) {
      i += 1
      continue
    }
    const ch = text[i]
    if (ch === ']') return { items, end: i + 1 }
    if (ch === '(') {
      let depth = 1
      let j = i + 1
      while (j < text.length && depth > 0) {
        if (text[j] === '\\') j += 2
        else {
          if (text[j] === '(') depth += 1
          else if (text[j] === ')') depth -= 1
          j += 1
        }
      }
      items.push({ kind: 'string', value: parseLiteralString(text.slice(i + 1, j - 1)) })
      i = j
      continue
    }
    if (ch === '<') {
      if (text[i + 1] === '<') {
        let depth = 0
        let j = i
        while (j < text.length) {
          if (text.startsWith('<<', j)) {
            depth += 1
            j += 2
          } else if (text.startsWith('>>', j)) {
            depth -= 1
            j += 2
            if (depth === 0) break
          } else j += 1
        }
        items.push({ kind: 'dict', value: text.slice(i, j) })
        i = j
        continue
      }
      const close = text.indexOf('>', i)
      const end = close === -1 ? text.length : close
      items.push({ kind: 'string', value: parseHexString(text.slice(i + 1, end)) })
      i = end + 1
      continue
    }
    if (ch === '/') {
      let j = i + 1
      while (j < text.length && !isWs(text.charCodeAt(j)) && !'/<>[]()'.includes(text[j])) j++
      items.push({ kind: 'name', value: text.slice(i + 1, j) })
      i = j
      continue
    }
    if (ch === '[') {
      const nested = parseArray(text, i + 1)
      items.push({ kind: 'array', items: nested.items })
      i = nested.end
      continue
    }
    const num = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(text.slice(i))
    if (num) {
      items.push({ kind: 'number', value: Number(num[0]) })
      i += num[0].length
      continue
    }
    i += 1
  }
  return { items, end: i }
}

/** Split a content stream into operators and their operands. */
function tokenizeContent(buf) {
  const text = buf.toString('latin1')
  const tokens = []
  let i = 0
  while (i < text.length) {
    const code = text.charCodeAt(i)
    if (isWs(code)) {
      i += 1
      continue
    }
    const ch = text[i]
    if (ch === '%') {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i += 1
      continue
    }
    if (ch === '(') {
      let depth = 1
      let j = i + 1
      while (j < text.length && depth > 0) {
        if (text[j] === '\\') j += 2
        else {
          if (text[j] === '(') depth += 1
          else if (text[j] === ')') depth -= 1
          j += 1
        }
      }
      tokens.push({ kind: 'string', value: parseLiteralString(text.slice(i + 1, j - 1)) })
      i = j
      continue
    }
    if (ch === '<') {
      if (text[i + 1] === '<') {
        let depth = 0
        let j = i
        while (j < text.length) {
          if (text.startsWith('<<', j)) {
            depth += 1
            j += 2
          } else if (text.startsWith('>>', j)) {
            depth -= 1
            j += 2
            if (depth === 0) break
          } else j += 1
        }
        tokens.push({ kind: 'dict', value: text.slice(i, j) })
        i = j
        continue
      }
      const close = text.indexOf('>', i)
      const end = close === -1 ? text.length : close
      tokens.push({ kind: 'string', value: parseHexString(text.slice(i + 1, end)) })
      i = end + 1
      continue
    }
    if (ch === '[') {
      const parsed = parseArray(text, i + 1)
      tokens.push({ kind: 'array', items: parsed.items })
      i = parsed.end
      continue
    }
    if (ch === ']') {
      i += 1
      continue
    }
    if (ch === '/') {
      let j = i + 1
      while (j < text.length && !isWs(text.charCodeAt(j)) && !'/<>[]()'.includes(text[j])) j++
      tokens.push({ kind: 'name', value: text.slice(i + 1, j) })
      i = j
      continue
    }
    const num = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(text.slice(i))
    if (num) {
      tokens.push({ kind: 'number', value: Number(num[0]) })
      i += num[0].length
      continue
    }
    let j = i
    while (j < text.length && !isWs(text.charCodeAt(j)) && !'/<>[]()'.includes(text[j])) j++
    if (j === i) j = i + 1
    tokens.push({ kind: 'operator', value: text.slice(i, j) })
    i = j
  }
  return tokens
}

/** Build a code-to-Unicode decoder from a /ToUnicode CMap stream. */
function parseToUnicode(buf) {
  const text = buf.toString('latin1')
  const map = new Map()
  let codeLength = 1
  const codeSpace = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(text)
  if (codeSpace) {
    const first = /<([0-9a-fA-F]+)>/.exec(codeSpace[1])
    if (first) codeLength = Math.max(1, first[1].length / 2)
  }
  const toText = hex => {
    const bytes = parseHexString(hex)
    if (bytes.length === 2 || bytes.length === 4) {
      let out = ''
      for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1])
      return out
    }
    if (bytes.length === 1) return String.fromCharCode(bytes[0])
    return bytes.toString('utf8')
  }
  const bfchar = /beginbfchar([\s\S]*?)endbfchar/g
  let match
  while ((match = bfchar.exec(text))) {
    const pairs = match[1].match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g) ?? []
    for (const pair of pairs) {
      const m = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/.exec(pair)
      const code = parseInt(m[1], 16)
      if (m[1].length / 2 > codeLength) codeLength = m[1].length / 2
      map.set(code, toText(m[2]))
    }
  }
  const bfrange = /beginbfrange([\s\S]*?)endbfrange/g
  while ((match = bfrange.exec(text))) {
    const body = match[1]
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]*)>|\[([\s\S]*?)\])/g
    let range
    while ((range = re.exec(body))) {
      const low = parseInt(range[1], 16)
      const high = parseInt(range[2], 16)
      if (range[1].length / 2 > codeLength) codeLength = range[1].length / 2
      if (high - low > 65535) continue
      if (range[4] !== undefined) {
        const start = parseHexString(range[4])
        const base = start.length === 1 ? start[0] : (start[start.length - 2] << 8) | start[start.length - 1]
        for (let code = low; code <= high; code++) {
          const delta = code - low
          if (start.length === 2) map.set(code, String.fromCharCode((base + delta) & 0xffff))
          else map.set(code, toText((range[4].length > 4 ? range[4] : '') + '') || String.fromCharCode((base + delta) & 0xff))
        }
      } else if (range[5] !== undefined) {
        const items = range[5].match(/<([0-9a-fA-F]*)>/g) ?? []
        items.forEach((item, index) => {
          const code = low + index
          if (code <= high) map.set(code, toText(item.slice(1, -1)))
        })
      }
    }
  }
  return { map, codeLength }
}

/** WinAnsiEncoding code points that differ from Latin-1. */
const WIN_ANSI = { 0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: "'", 0x92: "'", 0x93: '"', 0x94: '"', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ' }

/** Build a decoder for one font resource dictionary. */
function fontDecoder(doc, fontObject) {
  if (!fontObject) return { decode: bytes => bytes.toString('latin1') }
  const dict = fontObject.dict
  const toUnicodeRef = dict.ref('ToUnicode')
  if (toUnicodeRef) {
    const stream = doc.get(toUnicodeRef)
    const cmap = parseToUnicode(doc.decode(stream))
    if (cmap.map.size) {
      const { codeLength } = cmap
      return {
        decode(bytes) {
          let out = ''
          if (codeLength >= 2) {
            for (let i = 0; i + 1 < bytes.length; i += 2) {
              const code = (bytes[i] << 8) | bytes[i + 1]
              out += cmap.map.get(code) ?? ''
            }
            if (bytes.length % 2) out += cmap.map.get(bytes[bytes.length - 1]) ?? ''
          } else {
            for (const byte of bytes) out += cmap.map.get(byte) ?? ''
          }
          return out
        },
      }
    }
  }
  if (dict.scalar('Subtype') === 'Type0') {
    // Identity-H without a usable CMap: two-byte codes, no Unicode recovery.
    return {
      decode(bytes) {
        let out = ''
        for (let i = 0; i + 1 < bytes.length; i += 2) {
          const code = (bytes[i] << 8) | bytes[i + 1]
          if (code >= 0x20) out += String.fromCharCode(code)
        }
        return out
      },
    }
  }
  return {
    decode(bytes) {
      let out = ''
      for (const byte of bytes) out += WIN_ANSI[byte] ?? String.fromCharCode(byte)
      return out
    },
  }
}

/** Resolve a /Font resource name to a decoder, cached per resource dictionary. */
function fontFor(doc, resources, name, cache) {
  const key = `${resources?.dict?.text?.length ?? 0}:${name}`
  if (cache.has(key)) return cache.get(key)
  let decoder = fontDecoder(doc, undefined)
  const fonts = resources?.dict('Font')
  if (fonts) {
    const ref = fonts.ref(name)
    if (ref) decoder = fontDecoder(doc, doc.get(ref))
    else {
      const inline = fonts.raw(name)
      if (inline && inline.trim().startsWith('<<')) decoder = fontDecoder(doc, { dict: new Dict(inline) })
    }
  }
  cache.set(key, decoder)
  return decoder
}

/** Extract text from one content stream. */
function extractFromContent(doc, content, resources, collect, depth, visits, imageOut) {
  if (depth > 6) return
  const tokens = tokenizeContent(content)
  let fontName = ''
  let leading = 0
  let lineY = 0
  let lastY = Number.NaN
  let lineX = 0
  let pending = []
  const decoderCache = new Map()
  let decoder = fontDecoder(doc, undefined)
  const flush = () => {
    if (!pending.length) return
    collect.push(pending.join(''))
    pending = []
  }
  const newline = () => {
    flush()
    collect.push('\n')
  }
  const operands = []
  for (const token of tokens) {
    if (token.kind === 'string' || token.kind === 'number' || token.kind === 'name' || token.kind === 'dict' || token.kind === 'array') {
      operands.push(token)
      continue
    }
    if (token.kind === 'array-start') {
      operands.push({ kind: 'array', items: [] })
      continue
    }
    if (token.kind === 'array-end') {
      const array = [...operands].reverse().find(item => item.kind === 'array')
      if (array) array.closed = true
      continue
    }
    // Operator.
    const op = token.value
    if (op === 'Tf') {
      const nameToken = operands.filter(item => item.kind === 'name').at(-1)
      if (nameToken) {
        fontName = nameToken.value
        decoder = fontFor(doc, resources, fontName, decoderCache)
      }
    } else if (op === 'Td' || op === 'TD') {
      const nums = operands.filter(item => item.kind === 'number').map(item => item.value)
      if (nums.length >= 2) {
        lineX += nums[0]
        lineY += nums[1]
        if (nums[1] !== 0) newline()
      }
    } else if (op === 'T*') {
      lineY -= leading
      newline()
    } else if (op === 'TL') {
      const nums = operands.filter(item => item.kind === 'number')
      if (nums.length) leading = nums.at(-1).value
    } else if (op === 'Tm') {
      const nums = operands.filter(item => item.kind === 'number').map(item => item.value)
      if (nums.length >= 6) {
        const y = nums[5]
        if (!Number.isNaN(lastY) && Math.abs(y - lastY) > 1) newline()
        lastY = y
        lineX = nums[4]
        lineY = y
      }
    } else if (op === 'Tj') {
      const string = [...operands].reverse().find(item => item.kind === 'string')
      if (string) pending.push(decoder.decode(string.value))
    } else if (op === "'") {
      newline()
      const string = [...operands].reverse().find(item => item.kind === 'string')
      if (string) pending.push(decoder.decode(string.value))
    } else if (op === '"') {
      newline()
      const string = [...operands].reverse().find(item => item.kind === 'string')
      if (string) pending.push(decoder.decode(string.value))
    } else if (op === 'TJ') {
      const array = [...operands].reverse().find(item => item.kind === 'array')
      if (array) {
        for (const item of array.items) {
          if (item.kind === 'string') pending.push(decoder.decode(item.value))
          else if (item.kind === 'number' && item.value <= -200) {
            if (pending.at(-1)?.endsWith(' ')) continue
            pending.push(' ')
          }
        }
      }
    } else if (op === 'Do') {
      const nameToken = [...operands].reverse().find(item => item.kind === 'name')
      if (nameToken) {
        const xobjects = resources?.dict('XObject')
        const ref = xobjects?.ref(nameToken.value)
        const object = doc.get(ref)
        if (object && object.dict.scalar('Subtype') === 'Form') {
          const formResources = object.dict.dict('Resources') ?? resources
          const content = doc.decode(object)
          newline()
          extractFromContent(doc, content, formResources ?? resources, collect, depth + 1, visits, imageOut)
          newline()
        } else if (object && object.dict.scalar('Subtype') === 'Image' && Array.isArray(imageOut)) {
          // A scan is one painted image per page; remember the biggest one.
          imageOut.push(imageMeta(object))
        }
      }
    } else if (op === 'ET') {
      flush()
    }
    operands.length = 0
  }
  flush()
}

/** Normalize extracted text: join hyphenation, collapse spaces, trim lines. */
function normalizeText(raw) {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Extract per-page text from a PDF buffer.
 * @returns {{ pageCount: number, pages: string[], title: string | undefined }}
 */
export function extractPdfText(buf) {
  if (!buf || buf.length < 8) throw new Error('PDF_INVALID: file is too small')
  const head = buf.subarray(0, 1024).toString('latin1')
  if (!head.includes('%PDF')) throw new Error('PDF_INVALID: missing %PDF header')
  const doc = new PdfDocument(buf)
  const pageObjects = doc.pages()
  const pages = []
  const images = []
  for (const page of pageObjects) {
    const collect = []
    const imageOut = []
    const seen = new Set()
    const contentRaw = page.object.dict.raw('Contents')
    const refs = []
    if (contentRaw !== undefined) {
      const trimmed = contentRaw.trim()
      if (trimmed.startsWith('[')) {
        for (const item of page.object.dict.array('Contents')) {
          if (typeof item === 'object') refs.push(item)
        }
      } else {
        const single = page.object.dict.ref('Contents')
        if (single) refs.push(single)
        else refs.push(undefined)
      }
    }
    let resources = page.resources
    if (!resources) {
      // Walk up through /Parent for inherited resources.
      let parent = page.object.dict.ref('Parent')
      let hops = 0
      while (parent && hops < 16) {
        const object = doc.get(parent)
        resources = object?.dict.dict('Resources')
        if (resources) break
        parent = object?.dict.ref('Parent')
        hops += 1
      }
    }
    for (const ref of refs) {
      if (!ref) continue
      if (seen.has(ref.num)) continue
      seen.add(ref.num)
      const object = doc.get(ref)
      if (!object) continue
      extractFromContent(doc, doc.decode(object), resources, collect, 0, new Set(), imageOut)
    }
    pages.push(normalizeText(collect.join('')))
    let best
    for (const image of imageOut) {
      if (!best || image.width * image.height > best.width * best.height) best = image
    }
    images.push(best)
  }
  let title
  const infoRef = doc.trailer?.ref('Info')
  const info = doc.get(infoRef)
  if (info) {
    const rawTitle = info.dict.raw('Title')
    if (rawTitle?.startsWith('(')) {
      title = parseLiteralString(rawTitle.slice(1, -1)).toString('utf8').trim() || undefined
    }
  }
  return { pageCount: pages.length, pages, title, images: doc.trailer?.raw('Encrypt') === undefined ? images : [] }
}

/** Metadata for one painted image XObject (no bytes kept in memory). */
function imageMeta(object) {
  const dict = object.dict
  const rawFilter = String(dict.raw('Filter') ?? '').replace(/[[\]]/g, ' ').trim()
  const filter = rawFilter.split(/\s+/).filter(Boolean)[0]?.replace(/^\//, '') ?? ''
  const rawSpace = String(dict.raw('ColorSpace') ?? '').replace(/[[\]]/g, ' ').trim()
  const colorspace = rawSpace.split(/\s+/).filter(Boolean)[0]?.replace(/^\//, '') ?? 'DeviceGray'
  const parmsDict = dict.dict('DecodeParms') ?? dict.dict('DP')
  const parms = {}
  if (parmsDict) {
    for (const key of ['K', 'Columns', 'Rows', 'BlackIs1', 'EncodedByteAlign', 'EndOfLine', 'DamagedRowsBeforeError']) {
      const value = parmsDict.scalar(key)
      if (value !== undefined) parms[key] = value
    }
  }
  return {
    width: dict.scalar('Width') ?? 0,
    height: dict.scalar('Height') ?? 0,
    filter,
    colorspace,
    bpc: dict.scalar('BitsPerComponent') ?? 8,
    parms,
    streamStart: object.streamStart,
    streamEnd: object.streamEnd,
  }
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function pngChunk(type, body) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), body])), 0)
  return Buffer.concat([head, body, crc])
}

/** Encode 8-bit gray/RGB samples as a PNG (the only raster we can rebuild losslessly). */
export function encodePng(width, height, channels, samples) {
  const rowLength = width * channels
  const raw = Buffer.alloc((rowLength + 1) * height)
  for (let y = 0; y < height; y++) {
    const source = y * rowLength
    const target = y * (rowLength + 1)
    raw[target] = 0
    samples.copy(raw, target + 1, source, Math.min(source + rowLength, samples.length))
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = channels === 1 ? 0 : 2
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** Encode a 1-bit-per-pixel grayscale PNG; `white` holds 1 for white pixels. */
export function encodePng1(width, height, white) {
  const rowBytes = Math.ceil(width / 8)
  const raw = Buffer.alloc((rowBytes + 1) * height)
  for (let y = 0; y < height; y++) {
    const target = y * (rowBytes + 1)
    raw[target] = 0
    const rowBase = y * width
    for (let x = 0; x < width; x++) {
      if (white[rowBase + x]) raw[target + 1 + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 1
  header[9] = 0
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Read one page image as an encodable bitmap for OCR.
 * @returns {{ bytes: Buffer, mediaType: string } | undefined}
 */
/**
 * Shrink a 1-bit bitmap by an integer factor, keeping a block dark when any
 * of its pixels is dark so thin strokes survive the reduction.
 * @param {Uint8Array} white 1 = white
 * @param {number} width
 * @param {number} height
 * @param {number} factor
 * @returns {{ width: number, height: number, white: Uint8Array }}
 */
export function reduceBitmap1(white, width, height, factor) {
  if (factor <= 1) return { width, height, white }
  const outWidth = Math.ceil(width / factor)
  const outHeight = Math.ceil(height / factor)
  const out = new Uint8Array(outWidth * outHeight)
  for (let y = 0; y < outHeight; y += 1) {
    for (let x = 0; x < outWidth; x += 1) {
      let dark = false
      const yEnd = Math.min(height, (y + 1) * factor)
      const xEnd = Math.min(width, (x + 1) * factor)
      for (let sy = y * factor; sy < yEnd && !dark; sy += 1) {
        const row = sy * width
        for (let sx = x * factor; sx < xEnd; sx += 1) {
          if (!white[row + sx]) {
            dark = true
            break
          }
        }
      }
      out[y * outWidth + x] = dark ? 0 : 1
    }
  }
  return { width: outWidth, height: outHeight, white: out }
}

/**
 * Shrink 8-bit samples by an integer factor by averaging each block.
 * @param {Uint8Array} samples interleaved channel samples
 * @param {number} width
 * @param {number} height
 * @param {number} channels
 * @param {number} factor
 * @returns {{ width: number, height: number, samples: Uint8Array }}
 */
export function reduceSamples8(samples, width, height, channels, factor) {
  if (factor <= 1) return { width, height, samples }
  const outWidth = Math.ceil(width / factor)
  const outHeight = Math.ceil(height / factor)
  const out = new Uint8Array(outWidth * outHeight * channels)
  for (let y = 0; y < outHeight; y += 1) {
    const yEnd = Math.min(height, (y + 1) * factor)
    for (let x = 0; x < outWidth; x += 1) {
      const xEnd = Math.min(width, (x + 1) * factor)
      let count = 0
      const sums = new Array(channels).fill(0)
      for (let sy = y * factor; sy < yEnd; sy += 1) {
        for (let sx = x * factor; sx < xEnd; sx += 1) {
          const base = (sy * width + sx) * channels
          for (let c = 0; c < channels; c += 1) sums[c] += samples[base + c]
          count += 1
        }
      }
      const target = (y * outWidth + x) * channels
      for (let c = 0; c < channels; c += 1) out[target + c] = count ? Math.round(sums[c] / count) : 255
    }
  }
  return { width: outWidth, height: outHeight, samples: out }
}

export function readPageImage(buf, image, options = {}) {
  if (!image || image.streamStart < 0 || !image.width || !image.height) return undefined
  const maxWidth = Number(options.maxWidth) > 0 ? Number(options.maxWidth) : 0
  const factor = maxWidth ? Math.max(1, Math.ceil(image.width / maxWidth)) : 1
  const raw = buf.subarray(image.streamStart, image.streamEnd)
  if (image.filter === 'DCTDecode' || image.filter === 'DCT') {
    return { bytes: raw, mediaType: 'image/jpeg', width: image.width, height: image.height }
  }
  if (image.filter === 'CCITTFaxDecode' || image.filter === 'CCF') {
    const parms = image.parms ?? {}
    const flag = value => value === true || value === 'true'
    try {
      const bitmap = decodeCcitt(raw, {
        K: Number(parms.K ?? -1),
        Columns: Number(parms.Columns ?? image.width),
        Rows: Number(parms.Rows ?? image.height),
        BlackIs1: flag(parms.BlackIs1),
        EncodedByteAlign: flag(parms.EncodedByteAlign),
        EndOfLine: flag(parms.EndOfLine),
      })
      if (!bitmap.width || !bitmap.height) return undefined
      const reduced = reduceBitmap1(bitmap.white, bitmap.width, bitmap.height, factor)
      return { bytes: encodePng1(reduced.width, reduced.height, reduced.white), mediaType: 'image/png', width: reduced.width, height: reduced.height }
    } catch {
      return undefined
    }
  }
  if (image.filter === 'FlateDecode' || image.filter === 'Fl') {
    const channels = image.colorspace === 'DeviceRGB' ? 3 : image.colorspace === 'DeviceGray' ? 1 : 0
    if (!channels || image.bpc !== 8) return undefined
    const samples = inflate(raw)
    if (!samples.length) return undefined
    const reduced = reduceSamples8(samples, image.width, image.height, channels, factor)
    return { bytes: encodePng(reduced.width, reduced.height, channels, reduced.samples), mediaType: 'image/png', width: reduced.width, height: reduced.height }
  }
  return undefined
}
