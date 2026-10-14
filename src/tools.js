/**
 * The agent-facing half of the plugin: the tools over the ucloud client.
 *
 * The surface mirrors the ucloud workspace's own tools one-for-one, so the model
 * does what `tools/ucloud-cli.mjs` does and nothing invented on top:
 *
 * | workspace tool | here |
 * |---|---|
 * | `ucloud-cli.mjs whoami` | `ucloud_account` (证 `verify=true` 顺带登录校验) |
 * | `ucloud-cli.mjs list` | `ucloud_undone_list` |
 * | `ucloud-cli.mjs works` | `ucloud_works` |
 * | `ucloud-cli.mjs detail` | `ucloud_homework` |
 * | `ucloud-cli.mjs upload <路径>` | `ucloud_upload`（`path`，保持原文件名） |
 * | `ucloud-cli.mjs submit` | `ucloud_submit` |
 * | `hw/_dump-detail.mjs` | `ucloud_homework` 的 `raw` / `fields` 参数 |
 * | CLI 的 `.captcha.png` → `.captcha-answer` 往返 | `ucloud_account` 存图 + `ucloud_login` 回填 |
 *
 * The one deliberate difference is credentials: the CLI reads `.ucloud-pass` or
 * `UCLOUD_USER`/`UCLOUD_PASS`, while here 学号 comes from the plugin's settings
 * section and 密码 from the credential store — so the page and the tools can
 * never disagree about which account is in use.
 *
 * @module dsh-bupt-ucloud/tools
 */

import { randomUUID } from 'node:crypto'

import {
  OCR_TOKEN_REF,
  PASSWORD_REF,
  UcloudError,
  captchaImage,
  completeLogin,
  getDetail,
  getInfoWithCache,
  getResource,
  getToken,
  getUndoneList,
  isExpired,
  listWorks,
  searchCourse,
  searchCourses,
  submitAssignment,
  uploadFromUrl,
  uploadLocalFile,
} from './ucloud.js'
import { removeFileQuietly, writeCaptchaImage } from './state.js'

/** Activity kinds the platform reports in `undoneList`. */
const ACTIVITY_TYPES = { 2: '问卷', 3: '作业', 4: '测验' }

/** Cooperative budget for a tool call that walks every course of the account. */
const WALK_TIMEOUT_MS = 120_000

/** Cooperative budget for one small read. */
const READ_TIMEOUT_MS = 45_000

/** One hour in milliseconds. */
const HOUR_MS = 3_600_000

/** A deadline inside this window is called out on its own. */
const URGENT_WINDOW_MS = 24 * HOUR_MS

/** How long a pending captcha login stays usable. */
const PENDING_LOGIN_TTL_MS = 5 * 60_000

/** Most expired activities one listing will look up in detail. */
const MAX_EXPIRED_LOOKUPS = 20

/** The settings path every credential error points at. */
const SETTINGS_HINT = '「设置 → 插件 → 教学云」'

/** Pending captcha logins, keyed by the id handed to the model. */
const pendingLogins = new Map()

/* ------------------------------------------------------------------ *
 * Account resolution
 * ------------------------------------------------------------------ */

/**
 * Read one credential value through the credentials seam.
 * @param ctx - plugin context.
 * @param ref - credential reference name.
 * @returns the value, or undefined when unset or when no store is mounted.
 */
async function resolveCredential(ctx, ref) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined || typeof credentials.resolve !== 'function') return undefined
  const hit = await credentials.resolve(ref)
  return typeof hit?.value === 'string' && hit.value.length > 0 ? hit.value : undefined
}

/**
 * Read the account the tools work as.
 * @param ctx - plugin context.
 * @param env - plugin wiring (`username()` reads the settings section).
 * @returns 学号, 密码 and the optional OCR token.
 */
export async function readAccount(ctx, env) {
  const configured = env.username()
  const username = typeof configured === 'string' ? configured.trim() : ''
  const password = await resolveCredential(ctx, PASSWORD_REF)
  const ocrToken = await resolveCredential(ctx, OCR_TOKEN_REF)
  return { username, password, ocrToken }
}

/**
 * Save a captcha image and hold its CAS session for a follow-up tool call.
 * @param env - plugin wiring (the fetch seam).
 * @param session - the CAS session that demanded a captcha.
 * @param signal - cancellation signal of the running tool call.
 * @returns `{ captchaId, imagePath }`.
 */
async function stageCaptcha(env, session, signal) {
  for (const [id, entry] of pendingLogins) {
    if (entry.expiresAt <= Date.now()) {
      pendingLogins.delete(id)
      await removeFileQuietly(entry.file)
    }
  }
  const captchaId = randomUUID().replace(/-/g, '').slice(0, 8)
  const image = await captchaImage(session, { fetch: env.fetch, signal })
  const imagePath = await writeCaptchaImage(captchaId, image)
  pendingLogins.set(captchaId, { session, expiresAt: Date.now() + PENDING_LOGIN_TTL_MS, file: imagePath })
  return { captchaId, imagePath }
}

/**
 * The instruction a pending captcha carries, for both the model and the user.
 * @param captchaId - pending-login id.
 * @param imagePath - where the image was saved.
 * @returns the text.
 */
function captchaInstructions(captchaId, imagePath) {
  return `统一认证要求输入验证码，图片已保存到 ${imagePath}。请用 read_image 读取它（或让用户看一眼后把文字告诉你），`
    + `然后调用 ucloud_login(captchaId="${captchaId}", captcha="<验证码>") 完成登录；该验证码 5 分钟内有效。`
}

/**
 * Resolve a usable platform session for this call.
 *
 * A captcha with no OCR token becomes an actionable `captcha-required` error:
 * the image is on disk, the pending login is held, and the message names both
 * `read_image` and the exact `ucloud_login` call that finishes it.
 *
 * @param ctx - plugin context.
 * @param env - plugin wiring.
 * @param signal - cancellation signal of the running tool call.
 * @param force - skip the cached token and log in again.
 * @returns the account and its user info.
 */
async function session(ctx, env, signal, force = false) {
  const account = await readAccount(ctx, env)
  try {
    const userinfo = await getToken({ ...account, store: env.store, fetch: env.fetch, signal, force })
    return { account, userinfo }
  } catch (error) {
    const casSession = error instanceof UcloudError ? error.details?.session : undefined
    if (error instanceof UcloudError && error.code === 'captcha-required' && casSession) {
      const staged = await stageCaptcha(env, casSession, signal)
      throw new UcloudError('captcha-required', captchaInstructions(staged.captchaId, staged.imagePath), staged)
    }
    throw error
  }
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

/** Format one timestamp in local time as `YYYY-MM-DD HH:mm`. */
function formatTimestamp(ms) {
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Format a duration the way a person reads a deadline. */
function formatSpan(ms) {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} 小时 ${minutes % 60} 分`
  const days = Math.floor(hours / 24)
  return `${days} 天 ${hours % 24} 小时`
}

/** Format a platform timestamp string, or return it unchanged when unparsable. */
function formatPlatformTime(value) {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(ms) ? formatTimestamp(ms) : (value ?? '')
}

/**
 * Classify one activity's deadline against now.
 * @param endTime - the platform's `endTime` / `assignmentEndTime`.
 * @param now - current epoch milliseconds.
 * @returns `{ state, text }` with `state` one of none/future/urgent/expired.
 */
function classifyDeadline(endTime, now) {
  const at = typeof endTime === 'string' && endTime.length > 0 ? Date.parse(endTime) : Number.NaN
  if (!Number.isFinite(at)) return { state: 'none', text: '未设置' }
  const remaining = at - now
  if (remaining < 0) return { state: 'expired', text: `${formatTimestamp(at)}（已过期 ${formatSpan(-remaining)}）` }
  if (remaining <= URGENT_WINDOW_MS) return { state: 'urgent', text: `${formatTimestamp(at)}（剩 ${formatSpan(remaining)}）` }
  return { state: 'future', text: `${formatTimestamp(at)}（剩 ${formatSpan(remaining)}）` }
}

/**
 * The raw-field dump `hw/_dump-detail.mjs` prints: every field of the detail
 * record, sorted, long values truncated, optionally filtered by substring.
 *
 * @param detail - the platform's detail payload.
 * @param filters - report only fields whose name contains one of these.
 * @returns one `key = value` line per field.
 */
function dumpDetail(detail, filters = []) {
  const lines = []
  for (const key of Object.keys(detail).sort()) {
    if (filters.length > 0 && !filters.some((needle) => key.includes(needle))) continue
    let value = detail[key]
    if (typeof value === 'string' && value.length > 120) value = `${value.slice(0, 120)} …(len ${value.length})`
    else if (Array.isArray(value)) value = JSON.stringify(value).slice(0, 200)
    else if (value !== null && typeof value === 'object') value = JSON.stringify(value).slice(0, 200)
    lines.push(`${String(key).padEnd(26)} = ${String(value)}`)
  }
  return lines.join('\n')
}

/**
 * Render the platform's submission state (the CLI's `assignmentStatus` line).
 * @param detail - one activity's detail record.
 * @returns the state text.
 */
function describeSubmission(detail) {
  const status = detail.assignmentStatus
  const counts = typeof detail.noSubmitNum === 'number' && typeof detail.totalNum === 'number'
    ? ` 已提交 ${detail.totalNum - detail.noSubmitNum}/${detail.totalNum}`
    : ''
  if (status === 0) return `assignmentStatus=0（已提交）${counts}`
  if (status === 99) return `assignmentStatus=99（未提交）${counts}`
  if (status === undefined || status === null) {
    return typeof detail.submitTime === 'string' && detail.submitTime.length > 0
      ? `已提交（提交时间 ${formatPlatformTime(detail.submitTime)}）${counts}`
      : `平台未返回 assignmentStatus${counts}`
  }
  return `assignmentStatus=${status}（未知取值，请以平台页面为准）${counts}`
}

/**
 * Render whether a passed deadline can still be submitted (the CLI's 可逾期交 line).
 * @param detail - one activity's detail record.
 * @returns the overdue-submission text.
 */
function describeOvertime(detail) {
  const flag = detail.isOvertimeCommit
  if (flag === 0) return '0（可以补交）'
  if (flag === 1) return '1（不能补交）'
  return flag === undefined || flag === null ? '平台未返回 isOvertimeCommit' : String(flag)
}

/** One activity line for the triage listing. */
function itemLines(item, index) {
  const late = item.canLateSubmit === false ? '，已过期且不可补交' : item.canLateSubmit === true ? '，已过期但可补交' : ''
  return [
    `${index + 1}. [${ACTIVITY_TYPES[item.type] ?? `类型${item.type}`}] ${item.activityName}`,
    `   id: ${item.activityId}`,
    `   课程: ${item.courseInfo?.name ?? item.siteName ?? '未知'}${item.courseInfo?.teachers ? `（${item.courseInfo.teachers}）` : ''}`,
    `   截止: ${item.deadline.text}${late}`,
  ].join('\n')
}

/**
 * The calling session's workspace, as the built-in filesystem tools read it.
 *
 * A Web host serves several sessions from one process, so the process working
 * directory is not the caller's workspace; `exec.agent.session.header.cwd` is
 * the fact the fs tools resolve relative paths against.
 *
 * @param exec - the tool execution context.
 * @returns the session cwd, or undefined when the caller has no agent.
 */
function sessionCwd(exec) {
  try {
    const cwd = exec?.agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
  } catch {
    return undefined
  }
}

/**
 * Rewrite a value so `JSON.parse(JSON.stringify(value))` returns it unchanged.
 *
 * DSH requires every tool result to be lossless JSON: an `undefined` property
 * (or array element) is dropped by serialization and fails the whole call as
 * `value is not lossless JSON`. Optional platform fields are `undefined` all the
 * time, so every tool's output goes through here once, at the registry seam.
 *
 * @param value - the tool's canonical result.
 * @returns the same data with `undefined` written as `null`.
 */
function jsonSafe(value) {
  if (value === undefined) return null
  if (Array.isArray(value)) return value.map((entry) => jsonSafe(entry))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, child] of Object.entries(value)) out[key] = jsonSafe(child)
    return out
  }
  return value
}

/**
 * The display name of one attachment. The platform's `name` usually already
 * carries the extension, so the suffix is appended only when it is missing.
 * @param name - platform file name.
 * @param ext - platform extension, without the dot.
 * @returns the name to render.
 */
function attachmentName(name, ext) {
  const base = String(name ?? '')
  const suffix = String(ext ?? '')
  if (suffix.length === 0) return base
  return base.toLowerCase().endsWith(`.${suffix.toLowerCase()}`) ? base : `${base}.${suffix}`
}

/** @param content - model-facing text. */
function text(content) {
  return [{ type: 'text', text: content }]
}

/* ------------------------------------------------------------------ *
 * Tools — the CLI's `list`, `works`, `detail`, `upload`, `submit`, `whoami`
 * ------------------------------------------------------------------ */

/** `list`: unfinished activities, with the CLI's counter header and deadline triage. */
function undoneListTool(ctx, env) {
  return {
    name: 'ucloud_undone_list',
    description: 'List the unfinished assignments, quizzes and surveys of the configured BUPT 教学云 (ucloud) account, with the course each belongs to and its deadline. Anything due within 24 hours is called out in its own section; activities that expired while isOvertimeCommit=1 are listed separately and are not part of the todo list.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => text(value.report) },
    timeoutMs: WALK_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const { userinfo } = await session(ctx, env, exec.signal)
      const deps = { fetch: env.fetch, signal: exec.signal }
      const response = await getUndoneList(userinfo, deps)
      if (!response.success) throw new UcloudError('upstream-error', response.msg ?? '获取未完成列表失败')
      const raw = Array.isArray(response.data?.undoneList) ? response.data.undoneList : []
      const items = raw.map((item) => ({ ...item }))
      const state = await env.store.read()
      const missing = []
      for (const item of items) {
        const cached = state.homeworks[item.activityId]?.info
        if (cached) item.courseInfo = cached
        else missing.push(item)
      }
      if (missing.length > 0) {
        const found = await searchCourses(userinfo, missing, deps)
        if (Object.keys(found).length > 0) {
          await env.store.update((draft) => {
            for (const [id, info] of Object.entries(found)) {
              draft.homeworks[id] = { info, savedAt: new Date().toISOString() }
            }
          })
        }
        for (const item of missing) {
          if (found[item.activityId]) item.courseInfo = found[item.activityId]
        }
      }

      const now = Date.now()
      for (const item of items) item.deadline = classifyDeadline(item.endTime, now)

      // Expired work is only "not a todo" when the platform says it cannot be
      // resubmitted, and only `detail` carries that flag — so look up the few
      // expired items, bounded, and leave the rest unknown rather than assume.
      const expired = items.filter((item) => item.deadline.state === 'expired')
      if (expired.length > 0) {
        const lookups = expired.slice(0, MAX_EXPIRED_LOOKUPS)
        for (let index = 0; index < lookups.length; index += 5) {
          const batch = lookups.slice(index, index + 5)
          const details = await Promise.all(batch.map((item) => getDetail(item.activityId, userinfo, deps).catch(() => undefined)))
          for (let offset = 0; offset < details.length; offset += 1) {
            const detail = details[offset]?.data
            if (!detail) continue
            batch[offset].isOvertimeCommit = detail.isOvertimeCommit
            batch[offset].assignmentStatus = detail.assignmentStatus
            batch[offset].canLateSubmit = detail.isOvertimeCommit === 0
          }
        }
      }

      const urgent = items.filter((item) => item.deadline.state === 'urgent')
      const blocked = items.filter((item) => item.deadline.state === 'expired' && item.canLateSubmit === false)
      const todo = items.filter((item) => !blocked.includes(item))
      const sections = []
      sections.push(`未完成：${response.data?.undoneNum ?? items.length} 项（涉及 ${response.data?.siteNum ?? new Set(items.map((item) => item.siteName)).size} 门课）`)
      if (urgent.length > 0) {
        sections.push('', `🔴 24 小时内截止（${urgent.length} 项，最要紧）`)
        sections.push(...urgent.map((item, index) => itemLines(item, index)))
      }
      const rest = todo.filter((item) => !urgent.includes(item))
      if (rest.length > 0) {
        sections.push('', `待办（${rest.length} 项）`)
        sections.push(...rest.map((item, index) => itemLines(item, index)))
      }
      if (blocked.length > 0) {
        sections.push('', `⚪ 已过期且不可补交（${blocked.length} 项，按约定不列入待办）`)
        sections.push(...blocked.map((item, index) => itemLines(item, index)))
      }
      if (items.length === 0) sections.push('', '  （没有未完成的作业）')

      return {
        count: items.length,
        undoneNum: response.data?.undoneNum ?? items.length,
        siteNum: response.data?.siteNum ?? null,
        urgentCount: urgent.length,
        todoCount: todo.length,
        expiredBlockedCount: blocked.length,
        items: items.map((item) => ({
          activityId: item.activityId,
          activityName: item.activityName,
          type: item.type,
          typeName: ACTIVITY_TYPES[item.type] ?? String(item.type),
          courseName: item.courseInfo?.name ?? item.siteName ?? '',
          teachers: item.courseInfo?.teachers ?? '',
          endTime: item.endTime ?? '',
          deadlineState: item.deadline.state,
          // Only expired activities are looked up in detail; the rest stay null
          // so the value is lossless JSON (see jsonSafe).
          canLateSubmit: item.canLateSubmit ?? null,
          isOvertimeCommit: item.isOvertimeCommit ?? null,
        })),
        report: sections.join('\n'),
      }
    },
  }
}

/** `works`: walk every course and split submitted from unsubmitted. */
function worksTool(ctx, env) {
  return {
    name: 'ucloud_works',
    description: 'Walk every current BUPT 教学云 course and list its submitted and unsubmitted assignments — the check that a submission really landed, and the source of per-course progress. Every row carries the activity id.',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['all', 'submitted', 'unsubmitted'], description: 'Which side to report; defaults to all.' },
        course: { type: 'string', description: 'Only rows whose course name contains this text.' },
      },
      required: [],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => text(value.report) },
    timeoutMs: WALK_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const filter = args.filter === 'submitted' || args.filter === 'unsubmitted' ? args.filter : 'all'
      const needle = typeof args.course === 'string' ? args.course.trim() : ''
      const { userinfo } = await session(ctx, env, exec.signal)
      const result = await listWorks(userinfo, { fetch: env.fetch, signal: exec.signal })
      const matches = (row) => needle.length === 0 || row.courseName.includes(needle)
      const submitted = result.submitted.filter(matches)
      const unsubmitted = result.unsubmitted.filter(matches)
      const lines = []
      if (filter !== 'unsubmitted') {
        lines.push(`════ 已提交 ${submitted.length} 份 ════`)
        for (const row of submitted) lines.push(`  ${row.submitTime} | ${row.courseName} | ${row.title}  (id: ${row.activityId})`)
        if (submitted.length === 0) lines.push('  （无）')
      }
      if (filter !== 'submitted') {
        if (lines.length > 0) lines.push('')
        lines.push(`════ 未提交 ${unsubmitted.length} 份 ════`)
        for (const row of unsubmitted) {
          const deadline = classifyDeadline(row.endTime, Date.now())
          lines.push(`  截止 ${deadline.text} | ${row.courseName} | ${row.title}  (id: ${row.activityId})`)
        }
        if (unsubmitted.length === 0) lines.push('  （无）')
      }
      lines.push('', `（扫描 ${result.courses} 门课：已交 ${submitted.length} / 未交 ${unsubmitted.length}${result.failures.length > 0 ? `；${result.failures.length} 门课拉取失败` : ''}）`)
      return {
        courses: result.courses,
        submittedCount: submitted.length,
        unsubmittedCount: unsubmitted.length,
        failures: result.failures,
        submitted: submitted.map((row) => ({ activityId: row.activityId, title: row.title, courseName: row.courseName, submitTime: row.submitTime })),
        unsubmitted: unsubmitted.map((row) => ({ activityId: row.activityId, title: row.title, courseName: row.courseName, endTime: row.endTime })),
        report: lines.join('\n'),
      }
    },
  }
}

/** `detail` (plus `hw/_dump-detail.mjs`'s raw field dump). */
function homeworkTool(ctx, env) {
  return {
    name: 'ucloud_homework',
    description: 'Read one BUPT 教学云 activity by its id: title, content, course, chapter, start and deadline, submission state (assignmentStatus: 0=submitted, 99=not, with the submitted count), whether a late submission is accepted (isOvertimeCommit), attachment links — and with raw=true, every raw field the platform returns for it (like hw/_dump-detail.mjs).',
    parameters: {
      type: 'object',
      properties: {
        activityId: { type: 'string', description: 'Activity id (activityId) from ucloud_undone_list or ucloud_works.' },
        raw: { type: 'boolean', description: 'Report every raw platform field instead of the summary.' },
        fields: { type: 'array', items: { type: 'string' }, description: 'With raw=true, only fields whose name contains one of these substrings.' },
      },
      required: ['activityId'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => text(value.report) },
    timeoutMs: WALK_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const activityId = String(args.activityId ?? '').trim()
      if (activityId.length === 0) throw new UcloudError('invalid-arguments', 'activityId 不能为空')
      const { userinfo } = await session(ctx, env, exec.signal)
      const deps = { fetch: env.fetch, signal: exec.signal }
      const response = await getDetail(activityId, userinfo, deps)
      if (!response.success) throw new UcloudError('upstream-error', response.msg ?? '获取作业详情失败')
      const detail = response.data ?? {}

      if (args.raw === true) {
        const filters = Array.isArray(args.fields) ? args.fields.map(String).filter((value) => value.length > 0) : []
        return {
          activityId,
          fields: Object.keys(detail).sort(),
          raw: detail,
          report: dumpDetail(detail, filters),
        }
      }

      const courseInfo = await getInfoWithCache(userinfo, activityId, detail.assignmentTitle, env.store, deps)
      const resources = Array.isArray(detail.assignmentResource) && detail.assignmentResource.length > 0
        ? await getResource(userinfo, detail.assignmentResource, deps)
        : []
      const deadline = classifyDeadline(detail.assignmentEndTime, Date.now())
      const lines = [
        `标题     : ${detail.assignmentTitle ?? ''}`,
        `课程     : ${courseInfo?.name ?? detail.className ?? ''} ${detail.chapterName ?? ''}`.trimEnd(),
        `开始     : ${formatPlatformTime(detail.assignmentBeginTime)}`,
        `截止     : ${deadline.text}`,
        `状态     : ${describeSubmission(detail)}`,
        `可逾期交 : ${describeOvertime(detail)}`,
        // The CLI's note, kept because it is a documented trap: this list is the
        // teacher's attachments, not a limit on what the student may upload.
        `题目附件 : ${Array.isArray(detail.assignmentResource) ? detail.assignmentResource.length : 0} 个`
          + `${Array.isArray(detail.assignmentResource) && detail.assignmentResource.length > 0 ? `（${detail.assignmentResource.map((item) => item.resourceName ?? item.resourceId).join('、')}）` : ''}`,
      ]
      if (typeof detail.submitTime === 'string' && detail.submitTime.length > 0) {
        lines.push(`提交时间 : ${formatPlatformTime(detail.submitTime)}`)
      }
      if (typeof detail.assignmentScore === 'number' && detail.assignmentScore > 0) {
        lines.push(`评分     : ${detail.assignmentScore}`)
      }
      lines.push('', '正文：', String(detail.assignmentContent ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '（空）')
      if (resources.length > 0) {
        lines.push('', '下载地址：')
        for (const resource of resources) {
          lines.push(`- ${attachmentName(resource.name, resource.ext)}${resource.url ? `：${resource.url}` : ''}`)
        }
      }
      return {
        activityId,
        title: detail.assignmentTitle ?? '',
        courseName: courseInfo?.name ?? detail.className ?? '',
        teachers: courseInfo?.teachers ?? '',
        chapterName: detail.chapterName ?? '',
        content: detail.assignmentContent ?? '',
        beginTime: detail.assignmentBeginTime ?? '',
        endTime: detail.assignmentEndTime ?? '',
        deadlineState: deadline.state,
        // Raw platform fields, so a caller can re-check a claim this tool made.
        assignmentStatus: detail.assignmentStatus,
        noSubmitNum: detail.noSubmitNum,
        totalNum: detail.totalNum,
        isOvertimeCommit: detail.isOvertimeCommit,
        submitTime: detail.submitTime ?? null,
        assignmentScore: typeof detail.assignmentScore === 'number' ? detail.assignmentScore : null,
        resources: resources.map((resource) => ({ name: attachmentName(resource.name, resource.ext), url: resource.url ?? '' })),
        report: lines.join('\n'),
      }
    },
  }
}

/** Resolve which course one activity belongs to. */
function searchTool(ctx, env) {
  return {
    name: 'ucloud_search',
    description: 'Find which BUPT 教学云 course one activity belongs to by searching every course of the account with a keyword (the activity title is the best keyword).',
    parameters: {
      type: 'object',
      properties: {
        activityId: { type: 'string', description: 'Activity id to locate.' },
        keyword: { type: 'string', description: 'Search keyword, normally the activity title.' },
      },
      required: ['activityId', 'keyword'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => text(value.report) },
    timeoutMs: WALK_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const activityId = String(args.activityId ?? '').trim()
      const keyword = String(args.keyword ?? '').trim()
      if (activityId.length === 0 || keyword.length === 0) throw new UcloudError('invalid-arguments', 'activityId 与 keyword 都不能为空')
      const { userinfo } = await session(ctx, env, exec.signal)
      const deps = { fetch: env.fetch, signal: exec.signal }
      const course = await searchCourse(userinfo, activityId, keyword, deps)
      if (!course) return { activityId, keyword, found: false, report: '没有找到包含该活动的课程。' }
      return {
        activityId,
        keyword,
        found: true,
        course,
        report: `活动 ${activityId} 属于课程「${course.name}」${course.teachers ? `（${course.teachers}）` : ''}。`,
      }
    },
  }
}

/** `upload`: local path or URL, keeping the source file's own name. */
function uploadTool(ctx, env) {
  return {
    name: 'ucloud_upload',
    description: 'Upload an assignment attachment to BUPT 教学云 and return the resourceId ucloud_submit expects. The file comes either from a local path (path, like the CLI\'s upload <文件路径>) or from a URL (url). The attachment keeps the source file\'s own name unless filename is given explicitly — never rename an upload.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Local file path to upload: absolute, or relative to the session workspace (the harness process working directory when no workspace is registered).' },
        url: { type: 'string', description: 'File URL to download and upload.' },
        filename: { type: 'string', description: 'Stored filename; defaults to the source file\'s own name and is normally left unset.' },
        mimeType: { type: 'string', description: 'File MIME type; guessed from the extension when omitted.' },
      },
      required: [],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => text(value.report) },
    timeoutMs: WALK_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const url = typeof args.url === 'string' ? args.url.trim() : ''
      const filePath = typeof args.path === 'string' ? args.path.trim() : ''
      if ((url.length === 0) === (filePath.length === 0)) {
        throw new UcloudError('invalid-arguments', 'url 与 path 必须且只能提供一个')
      }
      const { userinfo } = await session(ctx, env, exec.signal)
      const deps = { fetch: env.fetch, signal: exec.signal, maxBytes: env.maxUploadBytes, mimeType: args.mimeType }
      const result = filePath.length > 0
        ? await uploadLocalFile(userinfo, filePath, {
          ...deps,
          // The calling session's workspace wins; the profile's first registered
          // workspace is only a fallback for callers without an agent.
          baseDir: sessionCwd(exec) ?? (typeof env.cwd === 'function' ? env.cwd() : undefined),
        })
        : await uploadFromUrl(userinfo, { url, filename: args.filename, mimeType: args.mimeType }, deps)
      return {
        resourceId: result.resourceId,
        previewUrl: result.previewUrl ?? '',
        filename: result.filename,
        mimeType: result.mimeType,
        report: `已上传 ${result.filename}（${result.mimeType}），resourceId: ${result.resourceId}`
          + `${result.previewUrl ? `\n预览地址: ${result.previewUrl}` : ''}`
          + '\n把 resourceId 报给用户确认后再调用 ucloud_submit。',
      }
    },
  }
}

/** `submit`. */
function submitTool(ctx, env) {
  return {
    name: 'ucloud_submit',
    description: 'Submit a BUPT 教学云 assignment with optional text content and attachments (resourceIds from ucloud_upload). This performs a real submission for the configured account.',
    parameters: {
      type: 'object',
      properties: {
        assignmentId: { type: 'string', description: 'Activity id to submit.' },
        content: { type: 'string', description: 'Assignment text content; may be omitted.' },
        attachmentIds: { type: 'array', items: { type: 'string' }, description: 'resourceIds returned by ucloud_upload.' },
      },
      required: ['assignmentId'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => text(value.report) },
    timeoutMs: READ_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const assignmentId = String(args.assignmentId ?? '').trim()
      if (assignmentId.length === 0) throw new UcloudError('invalid-arguments', 'assignmentId 不能为空')
      const attachmentIds = Array.isArray(args.attachmentIds) ? args.attachmentIds.map(String) : []
      const { userinfo } = await session(ctx, env, exec.signal)
      await submitAssignment(userinfo, { assignmentId, assignmentContent: args.content, attachmentIds }, { fetch: env.fetch, signal: exec.signal })
      return {
        success: true,
        assignmentId,
        attachments: attachmentIds.length,
        report: `已提交作业 ${assignmentId}${attachmentIds.length > 0 ? `（${attachmentIds.length} 个附件）` : ''}。`
          + '\n按约定请复核：ucloud_homework 看 assignmentStatus 是否变为 0，再用 ucloud_works 确认它出现在「已提交」列表里。',
      }
    },
  }
}

/** `whoami`, plus an optional real login and the captcha hand-off. */
function accountTool(ctx, env) {
  return {
    name: 'ucloud_account',
    description: 'Report the configured BUPT 教学云 account (学号, 姓名, userId, 角色), and with verify=true log in to prove the credentials. When 统一认证 demands a captcha and no OCR token is configured, the result carries the saved image path and the captchaId ucloud_login completes.',
    parameters: {
      type: 'object',
      properties: { verify: { type: 'boolean', description: 'Log in now and report the real name, roles and token state.' } },
      required: [],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => text(value.report) },
    timeoutMs: WALK_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const account = await readAccount(ctx, env)
      const configured = account.username.length > 0 && typeof account.password === 'string' && account.password.length > 0
      if (args.verify !== true) {
        return {
          configured,
          username: account.username,
          ocrTokenConfigured: typeof account.ocrToken === 'string' && account.ocrToken.length > 0,
          verified: false,
          report: configured
            ? `账号 ${account.username} 已配置${account.ocrToken ? '（含验证码识别令牌）' : '（未配置验证码识别令牌；遇到验证码会保存图片让你看一眼）'}。`
            : `尚未配置完整的账号：请在${SETTINGS_HINT}填写学号与密码。`,
        }
      }
      let userinfo
      try {
        ({ userinfo } = await session(ctx, env, exec.signal, true))
      } catch (error) {
        if (error instanceof UcloudError && error.code === 'captcha-required' && error.details?.captchaId) {
          return {
            configured: true,
            username: account.username,
            verified: false,
            captchaRequired: true,
            captchaId: error.details.captchaId,
            imagePath: error.details.imagePath,
            report: error.message,
          }
        }
        throw error
      }
      const roles = Array.isArray(userinfo.roles) ? userinfo.roles.map((role) => role.roleName) : []
      const lines = [
        `用户名  : ${userinfo.user_name ?? '(未知)'}`,
        `姓名    : ${userinfo.real_name ?? '(未知)'}`,
        `userId  : ${userinfo.user_id ?? '(未知)'}`,
        `角色    : ${roles.join(', ') || '(未取到)'}`,
        `令牌    : access_token ${isExpired(userinfo.access_token) ? '已过期' : '有效'}`,
      ]
      return {
        configured: true,
        username: account.username,
        realName: userinfo.real_name ?? '',
        userName: userinfo.user_name ?? '',
        userId: userinfo.user_id ?? '',
        roles,
        accessTokenValid: !isExpired(userinfo.access_token),
        verified: true,
        report: lines.join('\n'),
      }
    },
  }
}

/** The CLI's captcha answer file, as a tool call. */
function loginTool(ctx, env) {
  return {
    name: 'ucloud_login',
    description: 'Finish a login that 统一认证 stopped at a captcha: pass the captchaId from ucloud_account or from a captcha-required message together with the code read from the saved image. The session is valid for five minutes.',
    parameters: {
      type: 'object',
      properties: {
        captchaId: { type: 'string', description: 'Pending login id returned with the captcha image path.' },
        captcha: { type: 'string', description: 'The code shown in the saved captcha image.' },
      },
      required: ['captchaId', 'captcha'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => text(value.report) },
    timeoutMs: READ_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const captchaId = String(args.captchaId ?? '').trim()
      const captcha = String(args.captcha ?? '').trim()
      if (captchaId.length === 0 || captcha.length === 0) throw new UcloudError('invalid-arguments', 'captchaId 与 captcha 都不能为空')
      const pending = pendingLogins.get(captchaId)
      if (!pending) {
        throw new UcloudError('captcha-expired', '该验证码会话不存在或已过期；请重新调用 ucloud_account(verify=true) 或任意工具获取新的验证码图片。')
      }
      if (pending.expiresAt <= Date.now()) {
        pendingLogins.delete(captchaId)
        await removeFileQuietly(pending.file)
        throw new UcloudError('captcha-expired', '该验证码已超过 5 分钟有效期；请重新获取新的验证码图片。')
      }
      const account = await readAccount(ctx, env)
      try {
        const userinfo = await completeLogin({
          session: pending.session,
          captcha,
          username: account.username,
          password: account.password,
          store: env.store,
          fetch: env.fetch,
          signal: exec.signal,
        })
        pendingLogins.delete(captchaId)
        await removeFileQuietly(pending.file)
        const roles = Array.isArray(userinfo.roles) ? userinfo.roles.map((role) => role.roleName) : []
        return {
          verified: true,
          userName: userinfo.user_name ?? account.username,
          realName: userinfo.real_name ?? '',
          roles,
          report: `登录成功：${userinfo.real_name ?? ''}（${userinfo.user_name ?? account.username}）${roles.length > 0 ? `，角色：${roles.join('、')}` : ''}。`
            + '\n现在可以直接使用其他 ucloud_* 工具了。',
        }
      } catch (error) {
        // A wrong code is worth another try with the same session; anything else
        // drops it, so a stale cookie cannot be retried forever.
        if (!(error instanceof UcloudError) || !error.message.includes('验证码')) {
          pendingLogins.delete(captchaId)
          await removeFileQuietly(pending.file)
        }
        throw error
      }
    },
  }
}

/**
 * Build every tool definition.
 * @param ctx - plugin context.
 * @param env - plugin wiring.
 * @returns the tool definitions.
 */
export function toolDefinitions(ctx, env) {
  const definitions = [
    undoneListTool(ctx, env),
    worksTool(ctx, env),
    homeworkTool(ctx, env),
    searchTool(ctx, env),
    uploadTool(ctx, env),
    submitTool(ctx, env),
    accountTool(ctx, env),
    loginTool(ctx, env),
  ]
  // One seam, so no future field can reintroduce the lossless-JSON failure.
  return definitions.map((definition) => ({
    ...definition,
    async execute(args, exec) {
      return jsonSafe(await definition.execute(args, exec))
    },
  }))
}

export { pendingLogins }
