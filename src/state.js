/**
 * Local state for the ucloud plugin.
 *
 * Two things are kept: the per-account login token (so an expired access token
 * can be refreshed instead of re-running the CAS login and its captcha) and a
 * cache of the course info resolved for one activity id. Both live in one JSON
 * document under `$DSH_HOME/ucloud/`.
 *
 * The document holds refresh tokens, so it is written `0600` inside a `0700`
 * directory and never leaves the machine. Reads are cheap and always fresh;
 * writes go through one in-process queue so two tool calls cannot interleave a
 * read-modify-write.
 *
 * @module dsh-bupt-ucloud/state
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Current state document layout. */
const VERSION = 1

/**
 * The plugin's data directory.
 * @param home - override for `$DSH_HOME` (tests).
 * @returns absolute path of the plugin's data directory.
 */
export function dataRoot(home = process.env.DSH_HOME) {
  const base = typeof home === 'string' && home.length > 0 ? home : path.join(os.homedir(), '.dsh')
  return path.join(base, 'ucloud')
}

/**
 * The state document's path.
 *
 * One document per profile: a cached platform token and the course cache are
 * facts about one launch (`dsh.profile.bundles`, cwd, credentials handling),
 * and two profiles running at once must not interleave writes to one file. A
 * context with no profile (tests, embedded use) falls back to `state.json`.
 *
 * @param home - override for `$DSH_HOME` (tests).
 * @param profile - profile name; anything outside `[A-Za-z0-9._-]` is ignored.
 * @returns absolute path of the state document.
 */
export function statePath(home = process.env.DSH_HOME, profile = undefined) {
  const name = typeof profile === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(profile) ? profile : undefined
  return path.join(dataRoot(home), name === undefined ? 'state.json' : `${name}.json`)
}

/**
 * Where one pending login's captcha image is saved.
 *
 * The image is a throwaway PNG a human or a vision model reads; it lives beside
 * the state document so a login never writes outside the plugin's own directory.
 *
 * @param id - pending-login id (sanitized: it must stay one path segment).
 * @param home - override for `$DSH_HOME` (tests).
 * @returns absolute path of the captcha image.
 */
export function captchaImagePath(id, home = process.env.DSH_HOME) {
  const safe = typeof id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(id) ? id : 'pending'
  return path.join(dataRoot(home), `captcha-${safe}.png`)
}

/**
 * Save one captcha image with the same 0700/0600 discipline as the state file.
 * @param id - pending-login id.
 * @param bytes - PNG bytes.
 * @param home - override for `$DSH_HOME` (tests).
 * @returns the absolute path written.
 */
export async function writeCaptchaImage(id, bytes, home = process.env.DSH_HOME) {
  const file = captchaImagePath(id, home)
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, bytes, { mode: 0o600 })
  return file
}

/**
 * Delete a file, ignoring the case where it is already gone.
 * @param file - absolute path.
 */
export async function removeFileQuietly(file) {
  if (typeof file !== 'string' || file.length === 0) return
  try { await unlink(file) } catch {}
}

/** A state document with every section present. */
function emptyState() {
  return { version: VERSION, users: {}, homeworks: {} }
}

/** Narrow a parsed document to the shape this plugin reads. */
function normalize(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return emptyState()
  return {
    version: VERSION,
    users: raw.users !== null && typeof raw.users === 'object' && !Array.isArray(raw.users) ? { ...raw.users } : {},
    homeworks: raw.homeworks !== null && typeof raw.homeworks === 'object' && !Array.isArray(raw.homeworks) ? { ...raw.homeworks } : {},
  }
}

/**
 * One process-wide read/write queue over a JSON document.
 *
 * A missing, unreadable or corrupt file reads as empty rather than throwing:
 * the state is a cache, and the next login simply repopulates it.
 */
export class StateStore {
  /**
   * @param file - absolute path of the JSON document.
   */
  constructor(file = statePath()) {
    this.file = file
    this.tail = Promise.resolve()
  }

  /**
   * Read the current document.
   * @returns the parsed document, or an empty one when absent or corrupt.
   */
  async read() {
    try {
      return normalize(JSON.parse(await readFile(this.file, 'utf8')))
    } catch {
      return emptyState()
    }
  }

  /**
   * Read, mutate, and persist in one serialized step.
   *
   * The mutation runs against the document as it stands at the moment the step
   * is exclusive, so concurrent callers never lose each other's writes.
   *
   * @param mutate - receives the live document and returns the caller's value.
   * @returns the value the mutation returned.
   */
  async update(mutate) {
    const next = this.tail.then(async () => {
      const state = await this.read()
      const result = await mutate(state)
      await writeState(this.file, JSON.stringify(state))
      return result
    })
    // Keep the queue alive after a failed step, but let the caller see the failure.
    this.tail = next.then(() => undefined, () => undefined)
    return next
  }

  /**
   * Drop one user's cached token (a credential changed, or a refresh failed).
   * @param username - the account whose token is no longer trusted.
   */
  async forgetUser(username) {
    await this.update((state) => { delete state.users[username] })
  }
}

/**
 * Replace the document atomically: write a sibling temp file, then rename.
 * @param file - destination path.
 * @param text - serialized document.
 */
async function writeState(file, text) {
  const dir = path.dirname(file)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, text, { mode: 0o600 })
  await rename(tmp, file)
  // `rename` keeps the temp file's mode, but an existing destination on some
  // filesystems keeps its own; make the guarantee explicit.
  try { await chmod(file, 0o600) } catch {}
}
