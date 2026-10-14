/**
 * The agent-facing half of the plugin: six tools over the ucloud client.
 *
 * Every tool resolves the account the same way — 学号 from the plugin's own
 * settings section, 密码 and 验证码识别令牌 from the credential store — so the
 * model never sees, passes, or logs a credential. A tool that cannot resolve
 * them fails with a message naming the settings page, which is what the model
 * relays to the user.
 *
 * @module dsh-bupt-ucloud/tools
 */

import {
  OCR_TOKEN_REF,
  PASSWORD_REF,
  UcloudError,
  getDetail,
  getInfoWithCache,
  getResource,
  getToken,
  getUndoneList,
  isExpired,
  searchCourse,
  searchCourses,
  submitAssignment,
  uploadFromUrl,
} from './ucloud.js'

/** Activity kinds the platform reports in `undoneList`. */
const ACTIVITY_TYPES = { 2: '问卷', 3: '作业', 4: '测验' }

/** Cooperative budget for a tool call that walks every course of the account. */
const WALK_TIMEOUT_MS = 120_000

/** Cooperative budget for one small read. */
const READ_TIMEOUT_MS = 45_000

/** The settings path every credential error points at. */
const SETTINGS_HINT = '「设置 → 插件 → 教学云」'

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
 *
 * 学号 comes from this plugin's own settings section only — the page and the
 * tools must never disagree about which account is in use, so no environment or
 * credential fallback shadows an unset field.
 *
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
 * Resolve a usable platform session for this call.
 * @param ctx - plugin context.
 * @param env - plugin wiring.
 * @param signal - cancellation signal of the running tool call.
 * @param force - skip the cached token and log in again.
 * @returns the account and its user info.
 */
async function session(ctx, env, signal, force = false) {
  const account = await readAccount(ctx, env)
  const userinfo = await getToken({ ...account, store: env.store, fetch: env.fetch, signal, force })
  return { account, userinfo }
}

/** The JSON string a tool returns when nothing matched. */
function text(content) {
  return [{ type: 'text', text: content }]
}

/** Format one activity's deadline. */
function formatEndTime(value) {
  if (typeof value !== 'string' || value.length === 0) return '未设置'
  return value.replace('T', ' ').slice(0, 16)
}

/**
 * Render the platform's submission state.
 *
 * `assignmentStatus` is the field the platform moves on submission: `0` means
 * submitted, `99` means not submitted. Any other value is reported raw — this
 * tool asserts nothing it cannot see.
 *
 * @param detail - one activity's detail record.
 * @returns the state text.
 */
function describeSubmission(detail) {
  const status = detail.assignmentStatus
  if (status === 0) return '已提交（assignmentStatus=0）'
  if (status === 99) return '未提交（assignmentStatus=99）'
  if (status === undefined || status === null) {
    return typeof detail.submitTime === 'string' && detail.submitTime.length > 0 ? `已提交（提交时间 ${formatEndTime(detail.submitTime)}）` : '平台未返回 assignmentStatus'
  }
  return `assignmentStatus=${status}（未知取值，请以平台页面为准）`
}

/**
 * Render whether a passed deadline can still be submitted.
 *
 * `isOvertimeCommit` is `0` when the platform still accepts a late submission
 * and `1` when it does not.
 *
 * @param detail - one activity's detail record.
 * @returns the overdue-submission text.
 */
function describeOvertime(detail) {
  const flag = detail.isOvertimeCommit
  if (flag === 0) return '可以（isOvertimeCommit=0）'
  if (flag === 1) return '不可（isOvertimeCommit=1）'
  return flag === undefined || flag === null ? '平台未返回 isOvertimeCommit' : `isOvertimeCommit=${flag}`
}

/**
 * List the account's unfinished activities, with the course each belongs to.
 * @param ctx - plugin context.
 * @param env - plugin wiring.
 * @returns the tool definition.
 */
function undoneListTool(ctx, env) {
  return {
    name: 'ucloud_undone_list',
    description: 'List the unfinished assignments, quizzes and surveys of the configured BUPT 教学云 (ucloud) account, with the course each activity belongs to and its deadline.',
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
      const report = items.map((item, index) => [
        `${index + 1}. [${ACTIVITY_TYPES[item.type] ?? `类型${item.type}`}] ${item.activityName}`,
        `   id: ${item.activityId}`,
        `   课程: ${item.courseInfo?.name ?? item.siteName ?? '未知'}${item.courseInfo?.teachers ? `（${item.courseInfo.teachers}）` : ''}`,
        `   截止: ${formatEndTime(item.endTime)}`,
      ].join('\n')).join('\n')
      return {
        count: items.length,
        items: items.map((item) => ({
          activityId: item.activityId,
          activityName: item.activityName,
          type: item.type,
          typeName: ACTIVITY_TYPES[item.type] ?? String(item.type),
          courseName: item.courseInfo?.name ?? item.siteName ?? '',
          teachers: item.courseInfo?.teachers ?? '',
          endTime: item.endTime ?? '',
        })),
        report: items.length === 0 ? '当前没有未完成的作业、测验或问卷。' : `共 ${items.length} 项未完成：\n${report}`,
      }
    },
  }
}

/**
 * Read one assignment's detail.
 * @param ctx - plugin context.
 * @param env - plugin wiring.
 * @returns the tool definition.
 */
function homeworkTool(ctx, env) {
  return {
    name: 'ucloud_homework',
    description: 'Read one BUPT 教学云 activity by its id (from ucloud_undone_list): title, full assignment content, course, deadline, submission status, and download links for its attachments.',
    parameters: {
      type: 'object',
      properties: { activityId: { type: 'string', description: 'Activity id (activityId) from ucloud_undone_list.' } },
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
      const detail = response.data
      const courseInfo = await getInfoWithCache(userinfo, activityId, detail.assignmentTitle, env.store, deps)
      const resources = Array.isArray(detail.assignmentResource) && detail.assignmentResource.length > 0
        ? await getResource(userinfo, detail.assignmentResource, deps)
        : []
      const lines = [
        `标题: ${detail.assignmentTitle}`,
        `课程: ${courseInfo?.name ?? detail.className ?? '未知'}${courseInfo?.teachers ? `（${courseInfo.teachers}）` : ''}`,
        `章节: ${detail.chapterName ?? ''}`,
        `截止: ${formatEndTime(detail.assignmentEndTime)}`,
        `状态: ${describeSubmission(detail)}`,
        `逾期补交: ${describeOvertime(detail)}`,
      ]
      if (typeof detail.submitTime === 'string' && detail.submitTime.length > 0) {
        lines.push(`提交时间: ${formatEndTime(detail.submitTime)}`)
      }
      if (typeof detail.assignmentScore === 'number' && detail.assignmentScore > 0) {
        lines.push(`评分: ${detail.assignmentScore}`)
      }
      lines.push(
        '',
        '内容:',
        String(detail.assignmentContent ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '（无文字内容）',
      )
      if (resources.length > 0) {
        lines.push('', '附件:')
        for (const resource of resources) lines.push(`- ${resource.name}.${resource.ext}${resource.url ? `：${resource.url}` : ''}`)
      }
      return {
        activityId,
        title: detail.assignmentTitle,
        courseName: courseInfo?.name ?? detail.className ?? '',
        teachers: courseInfo?.teachers ?? '',
        content: detail.assignmentContent ?? '',
        endTime: detail.assignmentEndTime ?? '',
        // Raw platform fields, so a caller can re-check a claim this tool made.
        assignmentStatus: detail.assignmentStatus,
        isOvertimeCommit: detail.isOvertimeCommit,
        submitTime: detail.submitTime ?? null,
        assignmentScore: typeof detail.assignmentScore === 'number' ? detail.assignmentScore : null,
        resources: resources.map((resource) => ({ name: `${resource.name}.${resource.ext}`, url: resource.url ?? '' })),
        report: lines.join('\n'),
      }
    },
  }
}

/**
 * Resolve which course one activity belongs to.
 * @param ctx - plugin context.
 * @param env - plugin wiring.
 * @returns the tool definition.
 */
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
      if (!course) return { activityId, keyword, found: false, report: `没有找到包含该活动的课程。` }
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

/**
 * Upload one remote file as an assignment attachment.
 * @param ctx - plugin context.
 * @param env - plugin wiring.
 * @returns the tool definition.
 */
function uploadTool(ctx, env) {
  return {
    name: 'ucloud_upload',
    description: 'Download a file from a URL and upload it to BUPT 教学云 as an assignment attachment, returning the resourceId ucloud_submit expects.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'File URL to download and upload.' },
        filename: { type: 'string', description: 'Filename to store on the platform, extension included.' },
        mimeType: { type: 'string', description: 'File MIME type; defaults to application/octet-stream.' },
      },
      required: ['url', 'filename'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => text(value.report) },
    timeoutMs: WALK_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const url = String(args.url ?? '').trim()
      const filename = String(args.filename ?? '').trim()
      if (url.length === 0 || filename.length === 0) throw new UcloudError('invalid-arguments', 'url 与 filename 都不能为空')
      const { userinfo } = await session(ctx, env, exec.signal)
      const result = await uploadFromUrl(userinfo, { url, filename, mimeType: args.mimeType }, {
        fetch: env.fetch,
        signal: exec.signal,
        maxBytes: env.maxUploadBytes,
      })
      return {
        resourceId: result.resourceId,
        previewUrl: result.previewUrl ?? '',
        filename,
        report: `已上传 ${filename}，resourceId: ${result.resourceId}${result.previewUrl ? `\n预览地址: ${result.previewUrl}` : ''}`,
      }
    },
  }
}

/**
 * Submit one assignment.
 * @param ctx - plugin context.
 * @param env - plugin wiring.
 * @returns the tool definition.
 */
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
        report: `已提交作业 ${assignmentId}${attachmentIds.length > 0 ? `（${attachmentIds.length} 个附件）` : ''}。`,
      }
    },
  }
}

/**
 * Report the account state, optionally proving it by logging in.
 * @param ctx - plugin context.
 * @param env - plugin wiring.
 * @returns the tool definition.
 */
function accountTool(ctx, env) {
  return {
    name: 'ucloud_account',
    description: 'Report the configured BUPT 教学云 account: whether 学号 and 密码 are set, and — with verify=true — log in to return the real name, roles and token expiry. Use verify=true only when the user asks to check the credentials.',
    parameters: {
      type: 'object',
      properties: { verify: { type: 'boolean', description: 'Log in now and report the account\'s real name and roles.' } },
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
            ? `账号 ${account.username} 已配置${account.ocrToken ? '（含验证码识别令牌）' : '（未配置验证码识别令牌）'}。`
            : `尚未配置完整的账号：请在${SETTINGS_HINT}填写学号与密码。`,
        }
      }
      const { userinfo } = await session(ctx, env, exec.signal, true)
      const roles = Array.isArray(userinfo.roles) ? userinfo.roles.map((role) => role.roleName) : []
      return {
        configured: true,
        username: account.username,
        realName: userinfo.real_name ?? '',
        userName: userinfo.user_name ?? '',
        roles,
        accessTokenValid: !isExpired(userinfo.access_token),
        verified: true,
        report: `登录成功：${userinfo.real_name ?? ''}（${userinfo.user_name ?? account.username}）${roles.length > 0 ? `，角色：${roles.join('、')}` : ''}。`,
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
  return [
    undoneListTool(ctx, env),
    homeworkTool(ctx, env),
    searchTool(ctx, env),
    uploadTool(ctx, env),
    submitTool(ctx, env),
    accountTool(ctx, env),
  ]
}
