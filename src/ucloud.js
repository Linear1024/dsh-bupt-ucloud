/**
 * The ucloud platform client: everything the upstream worker
 * ([YouXam/ucloud](https://github.com/YouXam/ucloud), GPL-3.0) did behind its
 * HTTP routes, callable in-process.
 *
 * Three parts, ported from that worker verbatim where the wire format matters:
 *
 * - **Auth** — BUPT 统一认证 (CAS) login and ucloud token refresh, ported from
 *   [`@byrdocs/bupt-auth`](https://jsr.io/@byrdocs/bupt-auth) 0.3.0 (MIT). A
 *   captcha is solved through the Byrdocs OCR endpoint when the CAS page asks
 *   for one; the plugin gets its token from the settings page.
 * - **Crawler** — unfinished-work list, assignment detail, course discovery,
 *   resource preview URLs.
 * - **Mutation** — attachment upload and assignment submission.
 *
 * Every function takes an explicit `{ fetch, signal }` seam, so tests drive the
 * exact request the platform would receive without touching the network.
 *
 * @module dsh-ucloud/ucloud
 */

/** Platform origin every ucloud API call uses. */
export const UCLOUD_API = 'https://apiucloud.bupt.edu.cn'

/** Portal basic-auth credential the SPA itself sends (public, not a secret). */
const PORTAL_BASIC = 'Basic cG9ydGFsOnBvcnRhbF9zZWNyZXQ='

/** `identity` header the student SPA sends on list/detail reads. */
const STUDENT_IDENTITY = 'JS005:1528800428957896705'

/** CAS service the platform validates against. */
const CAS_SERVICE = 'https://ucloud.bupt.edu.cn'

/** CAS login endpoint, service included. */
const CAS_LOGIN_URL = `https://auth.bupt.edu.cn/authserver/login?service=${CAS_SERVICE}`

/** Byrdocs OCR endpoint used to answer the login captcha. */
const OCR_ENDPOINT = 'https://ocr.byrdocs.org/ocr'

/** Default ceiling on one downloaded-and-uploaded attachment. */
export const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024

/** The two credential references this plugin reads (see index.js). */
export const PASSWORD_REF = 'UCLOUD_PASSWORD'
export const OCR_TOKEN_REF = 'UCLOUD_OCR_TOKEN'

/** A failure with a stable machine-readable code. */
export class UcloudError extends Error {
  /**
   * @param code - short code tools and the settings page render.
   * @param message - human-readable reason, safe to show (never carries a secret).
   * @param details - optional structured context.
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'UcloudError'
    this.code = code
    this.details = details
  }
}

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

/** Decode a base64url JWT payload. */
function base64UrlDecode(value) {
  let input = value.replace(/-/g, '+').replace(/_/g, '/')
  while (input.length % 4) input += '='
  const binary = atob(input)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/**
 * Whether a JWT is absent, malformed, or past its `exp`.
 * @param token - the JWT to inspect.
 * @returns true when the token cannot be used.
 */
export function isExpired(token) {
  if (typeof token !== 'string' || token.length === 0) return true
  try {
    const payload = JSON.parse(base64UrlDecode(token.split('.')[1]))
    return typeof payload.exp !== 'number' || payload.exp < Date.now() / 1000
  } catch {
    return true
  }
}

/**
 * Fetch the CAS login page for a session cookie and the form's execution id.
 *
 * A captcha is reported only when the page carries a captcha config; when it
 * does, the caller must supply either `ocr` (this plugin's path) or `onCaptcha`.
 *
 * @param options - `ocr` token, or an `onCaptcha` callback, plus the fetch seam.
 * @returns the cookie, execution id, and the solved captcha text when required.
 */
async function openLoginSession(options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const response = await fetchImpl(CAS_LOGIN_URL, { signal: options.signal })
  const cookie = response.headers.get('set-cookie')?.split(';')?.[0]
  if (!cookie?.length) throw new UcloudError('login-failed', '登录失败：统一认证未返回会话 Cookie')
  const html = await response.text()
  const execution = /<input name="execution" value="(.*?)"/.exec(html)?.[1]
  if (!execution) throw new UcloudError('login-failed', '登录失败：统一认证页面缺少 execution 参数')
  const captchaId = /config.captcha[^{]*{[^}]*id: '(.*?)'/.exec(html)?.[1]
  if (!captchaId) return { cookie, execution }
  const captchaUrl = `https://auth.bupt.edu.cn/authserver/captcha?captchaId=${captchaId}&r=${Math.random().toString().slice(2, 7)}`
  if (typeof options.onCaptcha === 'function') {
    const captcha = await options.onCaptcha(captchaUrl, cookie)
    return { cookie, execution, captcha }
  }
  if (options.ocr?.token) {
    const captcha = await solveCaptcha(captchaUrl, cookie, options.ocr, fetchImpl, options.signal)
    return { cookie, execution, captcha }
  }
  throw new UcloudError(
    'captcha-required',
    '统一认证要求输入验证码，但未配置验证码识别令牌（OCR Token）。请在插件设置页填写，或换一个网络出口后重试。',
  )
}

/**
 * Ask the Byrdocs OCR service to read one captcha image.
 *
 * The token and the CAS cookie ride the query string, so no failure here ever
 * echoes the request URL (or anything derived from it) back to a caller.
 *
 * @param captchaUrl - captcha image URL on the CAS host.
 * @param cookie - the CAS session cookie the image belongs to.
 * @param ocr - `{ token, maxRetries? }`.
 * @returns the recognized text.
 */
async function solveCaptcha(captchaUrl, cookie, ocr, fetchImpl, signal) {
  const attempts = Number.isInteger(ocr.maxRetries) && ocr.maxRetries > 0 ? ocr.maxRetries : 3
  let lastDetail = '未知错误'
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const query = new URLSearchParams({ url: captchaUrl, token: ocr.token, cookie })
      const response = await fetchImpl(`${OCR_ENDPOINT}?${query}`, { signal })
      const data = await response.json().catch(() => undefined)
      if (data && typeof data.text === 'string' && data.text.length > 0) return data.text
      lastDetail = typeof data?.detail === 'string' && data.detail.length > 0 ? data.detail : '识别结果为空'
    } catch {
      // The thrown value may carry the request URL, which contains the OCR
      // token; only a fixed reason leaves this function.
      lastDetail = '无法连接验证码识别服务'
    }
  }
  throw new UcloudError('ocr-failed', `验证码识别失败：${lastDetail}`)
}

/**
 * Log in with 学号 and 统一认证密码.
 *
 * Mirrors `login()` of `@byrdocs/bupt-auth`: CAS form POST, ticket exchange for
 * a ucloud token, then the role list, then a role-scoped refresh so the caller
 * gets a usable `access_token`.
 *
 * @param username - 学号.
 * @param password - 统一认证密码.
 * @param options - OCR/captcha handling, a role override, and the fetch seam.
 * @returns the platform user info plus `roles`.
 */
export async function login(username, password, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const session = await openLoginSession(options)
  const body = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
    + (session.captcha ? `&captcha=${encodeURIComponent(session.captcha)}` : '')
    + '&submit=%E7%99%BB%E5%BD%95&type=username_password&execution=' + session.execution
    + '&_eventId=submit'
  const response = await fetchImpl(CAS_LOGIN_URL, {
    method: 'POST',
    headers: {
      authority: 'auth.bupt.edu.cn',
      'content-type': 'application/x-www-form-urlencoded',
      cookie: session.cookie,
      referer: CAS_LOGIN_URL,
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36 Edg/118.0.2088.61',
    },
    body,
    redirect: 'manual',
    signal: options.signal,
  })
  if (response.status !== 302) {
    const html = await response.text().catch(() => '')
    const upstreamError = /<div class="alert alert-danger" id="errorDiv">.*?<p>(.*?)<\/p>.*?<\/div>/s.exec(html)?.[1]
    if (response.status === 401) {
      if (upstreamError === 'Invalid credentials.') {
        throw new UcloudError('login-failed', '登录失败：学号或密码错误')
      }
      throw new UcloudError('login-failed', `登录失败：${upstreamError ?? '未知错误'}`)
    }
    throw new UcloudError('login-failed', `登录失败：统一认证返回 HTTP ${response.status}${upstreamError ? `（${upstreamError}）` : ''}`)
  }
  const location = response.headers.get('location')
  const ticket = location ? new URL(location, CAS_SERVICE).searchParams.get('ticket') : undefined
  if (!ticket) throw new UcloudError('login-failed', '登录失败：未取得 CAS ticket')
  const exchange = await fetchImpl(`${UCLOUD_API}/ykt-basics/oauth/token`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      authorization: PORTAL_BASIC,
      'content-type': 'application/x-www-form-urlencoded',
      'tenant-id': '000000',
      Referer: 'https://ucloud.bupt.edu.cn/',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
    body: `ticket=${encodeURIComponent(ticket)}&grant_type=third`,
    signal: options.signal,
  })
  if (!exchange.ok) throw new UcloudError('login-failed', `登录失败：换取令牌时返回 HTTP ${exchange.status}`)
  const initial = await exchange.json()
  const roles = await getUserRoles(initial.refresh_token, fetchImpl, options.signal)
  if (roles.length === 0) throw new UcloudError('login-failed', '登录失败：该账号在教学云没有任何角色')
  const role = options.role ?? roles[0].roleName
  const scoped = await refresh(initial.refresh_token, role, fetchImpl, options.signal)
  return { ...scoped, roles }
}

/**
 * Exchange a refresh token for a fresh access token.
 *
 * The multipart body matches `@byrdocs/bupt-auth`'s `refresh()` byte for byte:
 * the endpoint is unverified for a urlencoded body, so the proven encoding wins.
 *
 * @param refreshToken - the stored refresh token.
 * @param role - role name to scope the token to (optional).
 * @returns the refreshed user info.
 */
export async function refresh(refreshToken, role, fetchImpl = globalThis.fetch, signal) {
  const body = new FormData()
  body.append('grant_type', 'refresh_token')
  body.append('refresh_token', refreshToken)
  if (role) {
    const roles = await getUserRoles(refreshToken, fetchImpl, signal)
    const match = roles.find((entry) => entry.roleName === role)
    if (!match) throw new UcloudError('login-failed', `登录失败：账号不存在角色 ${role}`)
    body.append('identity', match.id)
  }
  const response = await fetchImpl(`${UCLOUD_API}/ykt-basics/oauth/token`, {
    method: 'POST',
    headers: { authorization: PORTAL_BASIC },
    body,
    signal,
  })
  if (!response.ok) throw new UcloudError('token-refresh-failed', `刷新令牌失败：HTTP ${response.status}`)
  return response.json()
}

/**
 * Read the account's roles.
 * @param token - access or refresh token.
 * @returns the role records.
 */
export async function getUserRoles(token, fetchImpl = globalThis.fetch, signal) {
  const response = await fetchImpl(`${UCLOUD_API}/ykt-basics/userroledomaindept/listByUserId`, {
    headers: { authorization: PORTAL_BASIC, 'Blade-Auth': token },
    signal,
  })
  if (!response.ok) throw new UcloudError('login-failed', `获取用户角色失败：HTTP ${response.status}`)
  const body = await response.json()
  return Array.isArray(body?.data) ? body.data : []
}

/**
 * Resolve a usable token for one account, reusing the cached one when it still
 * works — the port of the worker's `getToken()` against local state instead of D1.
 *
 * Order of preference: cached access token, refreshed access token, full login.
 *
 * @param options - account, credentials, the state store, and the fetch seam.
 * @returns the platform user info.
 */
export async function getToken(options) {
  const { username, password, ocrToken, store, force } = options
  const fetchImpl = options.fetch ?? globalThis.fetch
  const signal = options.signal
  if (typeof username !== 'string' || username.length === 0) {
    throw new UcloudError('missing-username', '未配置学号：请在「设置 → 插件 → 教学云」中填写学号')
  }
  if (typeof password !== 'string' || password.length === 0) {
    throw new UcloudError('missing-password', '未配置密码：请在「设置 → 插件 → 教学云」中填写统一认证密码')
  }
  if (!force && store) {
    const state = await store.read()
    const cached = state.users[username]?.userinfo
    if (cached && !isExpired(cached.refresh_token)) {
      if (!isExpired(cached.access_token)) return cached
      try {
        const next = await refresh(cached.refresh_token, undefined, fetchImpl, signal)
        await store.update((draft) => {
          draft.users[username] = { userinfo: next, savedAt: new Date().toISOString() }
        })
        return next
      } catch {
        // The refresh token looked valid but the platform refused it: log in again.
      }
    }
  }
  const userinfo = await login(username, password, {
    fetch: fetchImpl,
    signal,
    ocr: typeof ocrToken === 'string' && ocrToken.length > 0 ? { token: ocrToken } : undefined,
  })
  if (store) {
    await store.update((draft) => {
      draft.users[username] = { userinfo, savedAt: new Date().toISOString() }
    })
  }
  return userinfo
}

/* ------------------------------------------------------------------ *
 * Crawler
 * ------------------------------------------------------------------ */

/** Headers the student SPA sends on every authenticated platform read. */
function studentHeaders(token) {
  return {
    authorization: PORTAL_BASIC,
    'blade-auth': token,
    identity: STUDENT_IDENTITY,
    'tenant-id': '000000',
    Referer: 'https://ucloud.bupt.edu.cn/',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  }
}

/**
 * Fetch every unfinished activity of the account.
 * @param userinfo - platform user info.
 * @returns the platform's `undoneList` response.
 */
export async function getUndoneList(userinfo, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const response = await fetchImpl(`${UCLOUD_API}/ykt-site/site/student/undone?userId=${encodeURIComponent(userinfo.user_id)}`, {
    headers: { ...studentHeaders(userinfo.access_token), pragma: 'no-cache' },
    method: 'GET',
    signal: deps.signal,
  })
  return readJson(response, '获取未完成列表失败')
}

/**
 * Fetch one activity's detail.
 * @param id - assignment id (`activityId`).
 * @param userinfo - platform user info.
 * @returns the platform's detail response.
 */
export async function getDetail(id, userinfo, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const response = await fetchImpl(`${UCLOUD_API}/ykt-site/work/detail?assignmentId=${encodeURIComponent(id)}`, {
    headers: studentHeaders(userinfo.access_token),
    method: 'GET',
    signal: deps.signal,
  })
  return readJson(response, '获取作业详情失败')
}

/** Search one course's activity list for a keyword. */
async function searchTask(siteId, keyword, token, fetchImpl, signal) {
  const response = await fetchImpl(`${UCLOUD_API}/ykt-site/work/student/list`, {
    headers: { authorization: PORTAL_BASIC, 'blade-auth': token, 'content-type': 'application/json;charset=UTF-8' },
    body: JSON.stringify({ siteId, keyword, current: 1, size: 5 }),
    method: 'POST',
    signal,
  })
  return readJson(response, '搜索课程失败')
}

/** Every activity of one course. */
async function getHomeworks(siteId, token, fetchImpl, signal) {
  const response = await fetchImpl(`${UCLOUD_API}/ykt-site/work/student/list`, {
    headers: { authorization: PORTAL_BASIC, 'blade-auth': token, 'content-type': 'application/json;charset=UTF-8' },
    body: JSON.stringify({ siteId, current: 1, size: 9999 }),
    method: 'POST',
    signal,
  })
  return readJson(response, '获取课程作业失败')
}

/** Every quiz of one course. */
async function getTests(siteId, token, fetchImpl, signal) {
  const response = await fetchImpl(`${UCLOUD_API}/ykt-site/examination/list-stu?current=1&size=999999&status=-1&siteId=${encodeURIComponent(siteId)}&statusSelf=%E6%9C%AA%E6%8F%90%E4%BA%A4&state=-1`, {
    headers: { authorization: PORTAL_BASIC, 'blade-auth': token },
    signal,
  })
  return readJson(response, '获取课程测验失败')
}

/** Every pending survey of one course. */
async function getSurvey(userId, siteId, token, fetchImpl, signal) {
  const response = await fetchImpl(`${UCLOUD_API}/ykt-activity/survey/page/todo?level=1&size=9999999&userId=${encodeURIComponent(userId)}&siteId=${encodeURIComponent(siteId)}`, {
    headers: { authorization: PORTAL_BASIC, 'blade-auth': token },
    signal,
  })
  return readJson(response, '获取课程问卷失败')
}

/** The account's current courses, as the platform lists them. */
async function listCourses(userinfo, fetchImpl, signal) {
  const response = await fetchImpl(`${UCLOUD_API}/ykt-site/site/list/student/current?size=999999&current=1&userId=${encodeURIComponent(userinfo.user_id)}&siteRoleCode=2`, {
    headers: { authorization: PORTAL_BASIC, 'blade-auth': userinfo.access_token },
    method: 'GET',
    signal,
  })
  const body = await readJson(response, '获取课程列表失败')
  const records = Array.isArray(body?.data?.records) ? body.data.records : []
  return records.map((record) => ({
    id: record.id,
    name: record.siteName,
    teachers: Array.isArray(record.teachers) ? record.teachers.map((teacher) => teacher.name).join(', ') : '',
  }))
}

/**
 * Find the course one activity belongs to, by keyword-searching every course.
 * @param userinfo - platform user info.
 * @param id - activity id to locate.
 * @param keyword - activity title, used as the search keyword.
 * @returns the course info, or null when no course claims the activity.
 */
export async function searchCourse(userinfo, id, keyword, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const list = await listCourses(userinfo, fetchImpl, deps.signal)
  return searchWithLimit(list, id, keyword, userinfo.access_token, fetchImpl, deps.signal)
}

/** Search courses in batches of five until one owns `id`. */
async function searchWithLimit(list, id, keyword, token, fetchImpl, signal) {
  const limit = 5
  const wanted = String(id)
  for (let index = 0; index < list.length; index += limit) {
    const batch = list.slice(index, index + limit)
    const results = await Promise.all(batch.map((course) => searchTask(course.id, keyword, token, fetchImpl, signal)))
    for (let offset = 0; offset < results.length; offset += 1) {
      const records = results[offset]?.data?.records
      if (Array.isArray(records) && records.some((item) => String(item.id) === wanted)) return batch[offset]
    }
  }
  return null
}

/**
 * Resolve the course info of every unfinished item, grouped by activity type.
 *
 * This is the worker's `/undoneList` enrichment: surveys, homework and quizzes
 * are searched through their own endpoints against the same course list.
 *
 * @param userinfo - platform user info.
 * @param items - the unfinished list entries.
 * @returns activity id → course info, for the entries a course was found for.
 */
export async function searchCourses(userinfo, items, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const signal = deps.signal
  const list = await listCourses(userinfo, fetchImpl, signal)
  // Activity ids are compared as strings: the platform reports 19-digit ids,
  // which a JSON number cannot represent exactly, and the upstream worker's
  // loose comparison tolerated either wire type.
  const wanted = new Map(items.map((item, index) => [String(item.activityId), index]))
  const types = {}
  for (const item of items) types[item.type] = true

  async function searchTyped(search) {
    const result = {}
    const limit = 5
    for (let index = 0; index < list.length; index += limit) {
      const batch = list.slice(index, index + limit)
      const results = await Promise.all(batch.map((course) => search(course.id)))
      for (let offset = 0; offset < results.length; offset += 1) {
        const records = results[offset]?.data?.records
        if (!Array.isArray(records)) continue
        for (const item of records) {
          const id = String(item.id)
          if (wanted.has(id)) result[id] = batch[offset]
        }
      }
      if (Object.keys(result).length === wanted.size) return result
    }
    return result
  }

  const result = {}
  if (types[2]) Object.assign(result, await searchTyped((siteId) => getSurvey(userinfo.user_id, siteId, userinfo.access_token, fetchImpl, signal)))
  if (types[3]) Object.assign(result, await searchTyped((siteId) => getHomeworks(siteId, userinfo.access_token, fetchImpl, signal)))
  if (types[4]) Object.assign(result, await searchTyped((siteId) => getTests(siteId, userinfo.access_token, fetchImpl, signal)))
  return result
}

/**
 * Resolve the preview URL of one uploaded resource.
 * @param resourceId - storage id returned by the upload endpoint.
 * @returns the preview URL, or undefined when the platform returns none.
 */
export async function getPreviewURL(resourceId, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const response = await fetchImpl(`${UCLOUD_API}/blade-source/resource/preview-url?resourceId=${encodeURIComponent(resourceId)}`, { signal: deps.signal })
  const body = await readJson(response, '获取预览地址失败')
  return body?.data?.previewUrl
}

/**
 * Resolve the metadata and preview URL of the attachments one activity carries.
 * @param userinfo - platform user info.
 * @param resources - the activity's `assignmentResource` entries.
 * @returns one record per attachment, with its preview URL.
 */
export async function getResource(userinfo, resources, deps = {}) {
  if (resources.length === 0) return []
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const response = await fetchImpl(`${UCLOUD_API}/blade-source/resource/list/byId?resourceIds=${resources.map((item) => item.resourceId).join(',')}`, {
    headers: { authorization: PORTAL_BASIC, 'blade-auth': userinfo.access_token },
    signal: deps.signal,
  })
  const body = await readJson(response, '获取附件信息失败')
  if (!body.success) throw new UcloudError('upstream-error', body.msg ?? '获取附件信息失败')
  const ids = resources.map((item) => item.resourceId)
  const urls = {}
  const limit = 5
  for (let index = 0; index < ids.length; index += limit) {
    const batch = ids.slice(index, index + limit)
    const results = await Promise.all(batch.map((id) => getPreviewURL(id, deps).catch(() => undefined)))
    for (let offset = 0; offset < results.length; offset += 1) {
      if (results[offset]) urls[batch[offset]] = results[offset]
    }
  }
  return (body.data ?? []).map((entry) => ({
    storageId: entry.storageId,
    name: entry.name,
    ext: entry.ext,
    id: entry.id,
    url: urls[entry.id],
  }))
}

/* ------------------------------------------------------------------ *
 * Mutation
 * ------------------------------------------------------------------ */

/**
 * Read a response body into memory without ever exceeding `maxBytes`.
 *
 * `content-length` is a hint, not a guarantee: a chunked response (or a lying
 * server) carries none, so the byte count is enforced while reading and the
 * read is cancelled the moment the ceiling is crossed. Peak memory is one
 * `maxBytes` buffer plus one chunk, whatever the server claims.
 *
 * @param response - the download response.
 * @param maxBytes - size ceiling in bytes.
 * @returns the body bytes.
 */
async function readBounded(response, maxBytes) {
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new UcloudError('file-too-large', `文件超过 ${Math.floor(maxBytes / 1024 / 1024)} MB 上限`)
      chunks.push(value)
    }
  } finally {
    try { await reader.cancel() } catch {}
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/**
 * Download one file and upload it to the platform, returning its storage id.
 *
 * The worker streamed a hand-built multipart body through a `TransformStream`
 * with no buffering. Node's platform `FormData` needs the bytes up front, so
 * this reads them under a hard `maxBytes` ceiling instead (see
 * {@link readBounded}) — the same bound the worker's callers applied by size.
 *
 * @param userinfo - platform user info.
 * @param file - `{ url, filename, mimeType? }`.
 * @param deps - fetch seam, cancellation signal, and the size ceiling.
 * @returns the uploaded resource id and, when the platform answers, its preview URL.
 */
export async function uploadFromUrl(userinfo, file, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const maxBytes = Number.isFinite(deps.maxBytes) && deps.maxBytes > 0 ? deps.maxBytes : DEFAULT_MAX_UPLOAD_BYTES
  const download = await fetchImpl(file.url, { signal: deps.signal })
  if (!download.ok || !download.body) {
    throw new UcloudError('download-failed', `下载文件失败：HTTP ${download.status}`)
  }
  const declared = Number(download.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new UcloudError('file-too-large', `文件超过 ${Math.floor(maxBytes / 1024 / 1024)} MB 上限`)
  }
  const bytes = await readBounded(download, maxBytes)
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: file.mimeType || 'application/octet-stream' }), file.filename)
  form.append('userId', userinfo.user_id)
  form.append('bizType', '3')
  const response = await fetchImpl(`${UCLOUD_API}/blade-source/resource/upload/biz`, {
    method: 'POST',
    body: form,
    headers: { authorization: PORTAL_BASIC, 'Blade-Auth': userinfo.access_token },
    signal: deps.signal,
  })
  const body = await readJson(response, '上传附件失败')
  if (!response.ok || !body.success) {
    throw new UcloudError('upload-failed', body.msg ?? `上传附件失败：HTTP ${response.status}`)
  }
  const resourceId = body.data
  // The attachment exists now: a preview lookup failure must not read as an
  // upload failure, or a retry would upload a second copy.
  const previewUrl = await getPreviewURL(resourceId, deps).catch(() => undefined)
  return { resourceId, previewUrl }
}

/**
 * Submit one assignment.
 * @param userinfo - platform user info.
 * @param submission - `{ assignmentId, assignmentContent?, attachmentIds? }`.
 * @returns the platform's success flag.
 */
export async function submitAssignment(userinfo, submission, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const response = await fetchImpl(`${UCLOUD_API}/ykt-site/work/submit`, {
    method: 'POST',
    body: JSON.stringify({
      attachmentIds: submission.attachmentIds ?? [],
      assignmentContent: submission.assignmentContent ?? '',
      assignmentId: submission.assignmentId,
      assignmentType: 0,
      userId: userinfo.user_id,
      groupId: '',
      commitId: '',
    }),
    headers: { 'content-type': 'application/json', authorization: PORTAL_BASIC, 'Blade-Auth': userinfo.access_token },
    signal: deps.signal,
  })
  const body = await readJson(response, '提交作业失败')
  if (!body.success) throw new UcloudError('submit-failed', body.msg ?? '提交作业失败', { status: response.status })
  return { success: true }
}

/* ------------------------------------------------------------------ *
 * Shared reads
 * ------------------------------------------------------------------ */

/** Parse one platform JSON response, mapping a transport failure to a typed error. */
async function readJson(response, what) {
  if (!response.ok) throw new UcloudError('upstream-error', `${what}：HTTP ${response.status}`)
  try {
    return await response.json()
  } catch {
    throw new UcloudError('upstream-error', `${what}：平台返回的不是 JSON（登录可能已过期）`)
  }
}

/**
 * Resolve one activity's course info through the local cache first.
 *
 * The worker cached this in the `homeworks` D1 table; here it is the same
 * section of the local state document, so a repeated read of one assignment
 * does not walk the account's whole course list again.
 *
 * @param userinfo - platform user info.
 * @param id - activity id.
 * @param keyword - activity title, used as the search keyword.
 * @param store - the state store, or undefined to skip caching.
 * @param deps - fetch seam and cancellation signal.
 * @returns the course info, or null when no course claims the activity.
 */
export async function getInfoWithCache(userinfo, id, keyword, store, deps = {}) {
  if (store) {
    const state = await store.read()
    const cached = state.homeworks[id]
    if (cached && cached.info !== undefined) return cached.info
  }
  const info = await searchCourse(userinfo, id, keyword, deps)
  if (store && info) {
    await store.update((draft) => {
      draft.homeworks[id] = { info, savedAt: new Date().toISOString() }
    })
  }
  return info
}
