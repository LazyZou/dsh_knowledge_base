/**
 * Persistent background-job bookkeeping for the PDF knowledge base.
 *
 * A job is a small record of work that must survive a browser refresh (or a
 * DSH restart): a batch of PDFs to import, or a scan whose pages still need
 * recognition. The queue itself lives in `jobs.json` next to the documents.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/** Finished jobs kept around so the panel can still show what happened. */
const MAX_JOBS = 20

export const TERMINAL = new Set(['done', 'failed', 'cancelled'])

function newId() {
  return crypto.randomBytes(8).toString('hex')
}

export function timeOf() {
  return new Date().toISOString()
}

export class JobStore {
  constructor(dir) {
    this.file = path.join(dir, 'jobs.json')
    this.jobs = []
    this.loaded = false
    this.pending = Promise.resolve()
  }

  async load() {
    if (this.loaded) return this.jobs
    this.loaded = true
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'))
      const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : []
      this.jobs = jobs.filter(job => job && typeof job.id === 'string')
    } catch {
      this.jobs = []
    }
    return this.jobs
  }

  /** Writes are serialized so concurrent route handlers cannot interleave. */
  save() {
    const payload = JSON.stringify({ version: 1, jobs: this.jobs }, undefined, 2)
    this.pending = this.pending
      .then(() => fs.mkdir(path.dirname(this.file), { recursive: true }))
      .then(() => fs.writeFile(this.file, payload))
      .catch(() => {})
    return this.pending
  }

  get(id) {
    return this.jobs.find(job => job.id === id)
  }

  list() {
    return [...this.jobs].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }

  create({ kind, title, items }) {
    const job = {
      id: newId(),
      kind,
      title,
      state: 'queued',
      message: '',
      cancelRequested: false,
      total: items.length,
      done: 0,
      failed: 0,
      createdAt: timeOf(),
      updatedAt: timeOf(),
      finishedAt: null,
      items: items.map((item, index) => ({
        index,
        name: String(item.name ?? `document-${index + 1}`),
        state: 'pending',
        uploaded: false,
        size: 0,
        documentId: null,
        recognized: 0,
        remaining: 0,
        error: '',
        code: '',
      })),
    }
    this.jobs.unshift(job)
    this.trim()
    return job
  }

  remove(id) {
    const index = this.jobs.findIndex(job => job.id === id)
    if (index < 0) return false
    this.jobs.splice(index, 1)
    return true
  }

  /** Drops the oldest finished jobs once the history grows past MAX_JOBS. */
  trim() {
    const finished = this.jobs
      .filter(job => TERMINAL.has(job.state))
      .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))
    while (this.jobs.length > MAX_JOBS && finished.length) {
      const victim = finished.shift()
      this.jobs = this.jobs.filter(job => job.id !== victim.id)
    }
  }

  touch(job) {
    job.updatedAt = timeOf()
    return this.save()
  }
}

/** Counters the panel draws as one progress bar per job. */
export function progressOf(job) {
  if (job.kind === 'ocr') {
    const item = job.items[0] ?? {}
    const total = Number(item.pages) || Number(job.total) || 0
    const done = Number(item.recognized) || 0
    const remaining = Number(item.remaining) || 0
    const processed = total ? Math.max(0, total - remaining) : done
    return { total, done: processed, ratio: total ? Math.min(1, processed / total) : 0 }
  }
  const settled = job.items.filter(item => item.state === 'done' || item.state === 'failed' || item.state === 'cancelled').length
  return { total: job.total, done: settled, ratio: job.total ? settled / job.total : 0 }
}

/** Re-queues work that was interrupted by a restart. */
export async function recover(jobs, exists) {
  let changed = false
  for (const job of jobs) {
    if (TERMINAL.has(job.state)) continue
    job.state = 'queued'
    job.cancelRequested = false
    for (const item of job.items) {
      if (item.state === 'running') {
        item.state = job.kind === 'import' && item.tempFile ? 'uploaded' : 'pending'
        changed = true
      }
      if (job.kind === 'import' && item.state === 'uploaded' && item.tempFile) {
        const alive = await exists(item.tempFile)
        if (!alive) {
          item.state = 'failed'
          item.code = 'PDF_IMPORT_ABORTED'
          item.error = 'the upload did not finish before the restart'
          changed = true
        }
      }
    }
    changed = true
  }
  return changed
}
