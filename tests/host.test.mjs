/**
 * Host-half verification: the ported ucloud client, the local state store, the
 * six agent tools, and the settings page's login-check route — all driven
 * against a mocked platform, so nothing here touches the network.
 *
 * Run: node tests/host.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { StateStore, statePath, dataRoot } from '../src/state.js'
import {
  UcloudError,
  getToken,
  isExpired,
  login,
  refresh,
  searchCourses,
  uploadFromUrl,
} from '../src/ucloud.js'
import { toolDefinitions } from '../src/tools.js'
import { ROUTE_PREFIX, VERIFY_PATH, createRouteHandler } from '../src/route.js'
import { DEPLOYED } from './paths.mjs'

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

let passed = 0
const failures = []
async function check(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failures.push(label)
    console.error(`FAIL  ${label}\n      ${error?.stack ?? error}`)
    process.exitCode = 1
  }
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function html(value, status = 200, headers = {}) {
  return new Response(value, { status, headers: { 'content-type': 'text/html', ...headers } })
}

/** base64url-encode a JWT payload with a relative `exp`. */
function jwt(seconds) {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds }))
    .toString('base64url')
  return `header.${payload}.signature`
}

/**
 * A fetch stand-in: first matching route wins, every request is recorded.
 * @param routes - `{ method?, match, reply }` entries; `reply` may be a function.
 */
function mockFetch(routes) {
  const calls = []
  const impl = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url
    const method = String(init.method ?? 'GET').toUpperCase()
    calls.push({ url, method, init })
    for (const route of routes) {
      if (route.method !== undefined && route.method !== method) continue
      if (!url.includes(route.match)) continue
      return typeof route.reply === 'function' ? route.reply({ url, method, init }) : route.reply
    }
    throw new Error(`unexpected request: ${method} ${url}`)
  }
  impl.calls = calls
  impl.urls = () => calls.map((call) => `${call.method} ${call.url}`)
  return impl
}

async function tempStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-bupt-ucloud-'))
  return new StateStore(path.join(dir, 'state.json'))
}

/** A fake plugin context exposing only what the tools read. */
function fakeCtx({ credentials = {}, connection } = {}) {
  return {
    get(name) {
      if (name === 'credentials') {
        return {
          resolve: async (ref) => (credentials[ref] === undefined ? undefined : { value: credentials[ref] }),
        }
      }
      if (name === 'connection') return connection
      return undefined
    },
  }
}

async function callTool(name, { ctx, env, args = {}, signal } = {}) {
  const definition = toolDefinitions(ctx, env).find((tool) => tool.name === name)
  assert.ok(definition, `tool ${name} is registered`)
  return definition.execute(args, { signal: signal ?? new AbortController().signal })
}

/** The routes a successful 学号+密码 CAS login takes. */
function loginRoutes({ captcha = false, fail = false } = {}) {
  const page = captcha
    ? `<input name="execution" value="e1"/><script>config.captcha = { id: 'cap1' }</script>`
    : '<input name="execution" value="e1"/>'
  return [
    {
      method: 'GET',
      match: 'authserver/login',
      reply: () => html(page, 200, { 'set-cookie': 'SESSION=s1; Path=/' }),
    },
    {
      method: 'GET',
      match: 'ocr.byrdocs.org',
      reply: () => json({ text: 'a1b2' }),
    },
    {
      method: 'POST',
      match: 'authserver/login',
      reply: ({ init }) => {
        assert.ok(String(init.body).includes('username=20210001'), 'login posts the student id')
        if (fail) {
          return html('<div class="alert alert-danger" id="errorDiv"><p>Invalid credentials.</p></div>', 401)
        }
        if (captcha) assert.ok(String(init.body).includes('captcha=a1b2'), 'login posts the solved captcha')
        return new Response(null, { status: 302, headers: { location: 'https://ucloud.bupt.edu.cn/?ticket=ST-1' } })
      },
    },
    {
      method: 'POST',
      match: 'ykt-basics/oauth/token',
      reply: ({ init }) => {
        const body = String(init.body)
        if (body.includes('grant_type=third')) {
          return json({ refresh_token: jwt(3600), access_token: jwt(60), user_id: 'U1', user_name: '20210001' })
        }
        return json({ refresh_token: jwt(3600), access_token: jwt(3600), user_id: 'U1', user_name: '20210001', real_name: '张三' })
      },
    },
    {
      method: 'GET',
      match: 'userroledomaindept',
      reply: () => json({ data: [{ id: 'r1', roleName: '学生' }] }),
    },
  ]
}

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

await check('the plugin entry exposes a loader-valid live settings section', async () => {
  const { resolveConfig } = await import(`${DEPLOYED}/cordis/lib/index.js`)
  const entry = await import('../index.js')
  assert.equal(entry.name, 'ucloud')
  assert.equal(typeof entry.apply, 'function')
  // The loader validates the exported Config through the Standard Schema seam.
  const resolved = resolveConfig({ Config: entry.Config }, { username: '20210001' })
  assert.equal(resolved.username.get(), '20210001')
  const schema = entry.Config.toJSON()
  const root = schema.refs[schema.uid]
  assert.equal(schema.refs[root.dict.username].meta.volatile, true, 'username is a volatile (editable) field')
})

await check('isExpired reads the JWT exp claim', () => {
  assert.equal(isExpired(jwt(600)), false)
  assert.equal(isExpired(jwt(-600)), true)
  assert.equal(isExpired('not-a-jwt'), true)
  assert.equal(isExpired(undefined), true)
})

await check('login walks CAS, the ticket exchange, roles and the scoped refresh', async () => {
  const fetchImpl = mockFetch(loginRoutes())
  const userinfo = await login('20210001', 'pw', { fetch: fetchImpl })
  assert.equal(userinfo.access_token, jwt(3600))
  assert.deepEqual(userinfo.roles.map((role) => role.roleName), ['学生'])
  assert.deepEqual(fetchImpl.urls().map((url) => url.split('?')[0]), [
    'GET https://auth.bupt.edu.cn/authserver/login',
    'POST https://auth.bupt.edu.cn/authserver/login',
    'POST https://apiucloud.bupt.edu.cn/ykt-basics/oauth/token',
    'GET https://apiucloud.bupt.edu.cn/ykt-basics/userroledomaindept/listByUserId',
    'GET https://apiucloud.bupt.edu.cn/ykt-basics/userroledomaindept/listByUserId',
    'POST https://apiucloud.bupt.edu.cn/ykt-basics/oauth/token',
  ])
})

await check('login solves a captcha through the OCR service', async () => {
  const fetchImpl = mockFetch(loginRoutes({ captcha: true }))
  const userinfo = await login('20210001', 'pw', { fetch: fetchImpl, ocr: { token: 'ocr-token' } })
  assert.equal(userinfo.user_id, 'U1')
  const ocrCall = fetchImpl.calls.find((call) => call.url.includes('ocr.byrdocs.org'))
  assert.ok(ocrCall.url.includes('token=ocr-token'), 'the OCR token rides the request')
})

await check('an OCR failure never carries the token back to a caller', async () => {
  const routes = loginRoutes({ captcha: true }).map((route) => route.match === 'ocr.byrdocs.org'
    ? { ...route, reply: () => { throw new Error('request to https://ocr.byrdocs.org/ocr?url=x&token=ocr-token&cookie=SESSION%3Ds1 failed') } }
    : route)
  await assert.rejects(
    () => login('20210001', 'pw', { fetch: mockFetch(routes), ocr: { token: 'ocr-token' } }),
    (error) => error instanceof UcloudError
      && error.code === 'ocr-failed'
      && !error.message.includes('ocr-token')
      && error.message.includes('无法连接验证码识别服务'),
  )
})

await check('login without an OCR token refuses a captcha instead of guessing', async () => {
  const fetchImpl = mockFetch(loginRoutes({ captcha: true }))
  await assert.rejects(
    () => login('20210001', 'pw', { fetch: fetchImpl }),
    (error) => error instanceof UcloudError && error.code === 'captcha-required',
  )
})

await check('a wrong password surfaces as 学号或密码错误', async () => {
  const fetchImpl = mockFetch(loginRoutes({ fail: true }))
  await assert.rejects(
    () => login('20210001', 'nope', { fetch: fetchImpl }),
    (error) => error instanceof UcloudError && error.code === 'login-failed' && error.message.includes('学号或密码错误'),
  )
})

await check('getToken requires both credentials and names the settings page', async () => {
  const store = await tempStore()
  await assert.rejects(
    () => getToken({ username: '', password: 'x', store, fetch: mockFetch([]) }),
    (error) => error.code === 'missing-username' && error.message.includes('设置 → 插件'),
  )
  await assert.rejects(
    () => getToken({ username: '20210001', password: '', store, fetch: mockFetch([]) }),
    (error) => error.code === 'missing-password',
  )
})

await check('getToken reuses a live cached token without touching the network', async () => {
  const store = await tempStore()
  await store.update((draft) => {
    draft.users['20210001'] = { userinfo: { access_token: jwt(600), refresh_token: jwt(7200), user_id: 'U1' } }
  })
  const fetchImpl = mockFetch([])
  const userinfo = await getToken({ username: '20210001', password: 'pw', store, fetch: fetchImpl })
  assert.equal(userinfo.user_id, 'U1')
  assert.equal(fetchImpl.calls.length, 0)
})

await check('getToken refreshes an expired access token and re-caches it', async () => {
  const store = await tempStore()
  await store.update((draft) => {
    draft.users['20210001'] = { userinfo: { access_token: jwt(-10), refresh_token: jwt(7200), user_id: 'U1' } }
  })
  const fetchImpl = mockFetch([
    { method: 'POST', match: 'ykt-basics/oauth/token', reply: () => json({ access_token: jwt(3600), refresh_token: jwt(7200), user_id: 'U1' }) },
  ])
  const userinfo = await getToken({ username: '20210001', password: 'pw', store, fetch: fetchImpl })
  assert.equal(isExpired(userinfo.access_token), false)
  const state = await store.read()
  assert.equal(state.users['20210001'].userinfo.access_token, userinfo.access_token)
})

await check('getToken logs in again when the refresh token is refused', async () => {
  const store = await tempStore()
  await store.update((draft) => {
    draft.users['20210001'] = { userinfo: { access_token: jwt(-10), refresh_token: jwt(7200), user_id: 'U1' } }
  })
  let refreshCalls = 0
  const fetchImpl = mockFetch([
    {
      method: 'POST',
      match: 'ykt-basics/oauth/token',
      reply: ({ init }) => {
        const body = init.body instanceof FormData ? String(init.body.get('grant_type')) : String(init.body)
        if (body.includes('refresh_token')) {
          refreshCalls += 1
          // The cached refresh token is refused once; the login flow's own
          // refresh (the second call) succeeds.
          if (refreshCalls === 1) return json({ msg: 'refresh token expired' }, 401)
          return json({ refresh_token: jwt(3600), access_token: jwt(3600), user_id: 'U1' })
        }
        return json({ refresh_token: jwt(3600), access_token: jwt(60), user_id: 'U1' })
      },
    },
    ...loginRoutes(),
  ])
  const userinfo = await getToken({ username: '20210001', password: 'pw', store, fetch: fetchImpl })
  assert.equal(userinfo.user_id, 'U1')
  assert.ok(fetchImpl.calls.some((call) => call.url.includes('authserver/login')), 'it fell back to a full login')
})

await check('refresh scopes the token to the requested role', async () => {
  const fetchImpl = mockFetch([
    { method: 'GET', match: 'userroledomaindept', reply: () => json({ data: [{ id: 'r7', roleName: '助教' }] }) },
    { method: 'POST', match: 'ykt-basics/oauth/token', reply: ({ init }) => {
      assert.ok(init.body instanceof FormData, 'refresh posts the multipart body the ported library sends')
      assert.equal(init.body.get('grant_type'), 'refresh_token')
      assert.equal(init.body.get('identity'), 'r7')
      return json({ access_token: jwt(60) })
    } },
  ])
  const userinfo = await refresh(jwt(3600), '助教', fetchImpl)
  assert.equal(userinfo.access_token, jwt(60))
})

await check('refresh refuses a role the account does not hold', async () => {
  const fetchImpl = mockFetch([
    { method: 'GET', match: 'userroledomaindept', reply: () => json({ data: [{ id: 'r7', roleName: '助教' }] }) },
  ])
  await assert.rejects(() => refresh(jwt(3600), '教师', fetchImpl), (error) => error.code === 'login-failed')
})

/* ------------------------------------------------------------------ *
 * State store
 * ------------------------------------------------------------------ */

await check('the state document lives under $DSH_HOME/ucloud, one file per profile', () => {
  assert.equal(dataRoot('/home/example/.dsh'), path.join('/home/example/.dsh', 'ucloud'))
  assert.equal(statePath('/home/example/.dsh'), path.join('/home/example/.dsh', 'ucloud', 'state.json'))
  assert.equal(statePath('/home/example/.dsh', 'web'), path.join('/home/example/.dsh', 'ucloud', 'web.json'))
  // A profile name is a path segment: anything unusual falls back to the default.
  assert.equal(statePath('/home/example/.dsh', '../evil'), path.join('/home/example/.dsh', 'ucloud', 'state.json'))
  assert.equal(statePath('/home/example/.dsh', 'a/b'), path.join('/home/example/.dsh', 'ucloud', 'state.json'))
})

await check('the store writes 0600 into a 0700 directory and reads back', async () => {
  const store = await tempStore()
  await store.update((draft) => { draft.homeworks.A1 = { info: { name: 'Course A' }, savedAt: 'now' } })
  const file = await stat(store.file)
  const dir = await stat(path.dirname(store.file))
  assert.equal(file.mode & 0o777, 0o600)
  assert.equal(dir.mode & 0o777, 0o700)
  const state = await store.read()
  assert.equal(state.homeworks.A1.info.name, 'Course A')
  assert.equal(JSON.parse(await readFile(store.file, 'utf8')).homeworks.A1.info.name, 'Course A')
})

await check('a corrupt state file reads as empty rather than throwing', async () => {
  const store = await tempStore()
  await store.update(() => {})
  const { writeFile } = await import('node:fs/promises')
  await writeFile(store.file, '{not json')
  assert.deepEqual(await store.read(), { version: 1, users: {}, homeworks: {} })
})

await check('concurrent updates do not lose each other', async () => {
  const store = await tempStore()
  await Promise.all(Array.from({ length: 8 }, (_, index) => store.update((draft) => { draft.homeworks[`H${index}`] = { info: index, savedAt: 'now' } })))
  const state = await store.read()
  assert.equal(Object.keys(state.homeworks).length, 8)
})

await check('forgetUser drops exactly one cached token', async () => {
  const store = await tempStore()
  await store.update((draft) => {
    draft.users.a = { userinfo: {} }
    draft.users.b = { userinfo: {} }
  })
  await store.forgetUser('a')
  assert.deepEqual(Object.keys((await store.read()).users), ['b'])
})

/* ------------------------------------------------------------------ *
 * Tools
 * ------------------------------------------------------------------ */

const USER = { user_id: 'U1', access_token: jwt(3600), refresh_token: jwt(7200) }
const CREDENTIALS = { UCLOUD_PASSWORD: 'pw' }

const listingRoutes = [
  { method: 'GET', match: 'site/student/undone', reply: () => json({ success: true, data: { undoneList: [
    { activityId: 'A1', activityName: '第一次作业', type: 3, siteId: 11, siteName: '高等数学', endTime: '2026-01-01T23:59:00' },
    { activityId: 'A2', activityName: '随堂测验', type: 4, siteId: 11, siteName: '高等数学', endTime: '2026-01-02T12:00:00' },
  ] } }) },
  { method: 'GET', match: 'site/list/student/current', reply: () => json({ data: { records: [{ id: 11, siteName: '高等数学', teachers: [{ name: '李老师' }] }] } }) },
  { method: 'POST', match: 'ykt-site/work/student/list', reply: () => json({ data: { records: [{ id: 'A1' }] } }) },
  { method: 'GET', match: 'examination/list-stu', reply: () => json({ data: { records: [{ id: 'A2' }] } }) },
]

await check('ucloud_undone_list reports deadlines, courses and caches the course info', async () => {
  const store = await tempStore()
  await store.update((draft) => { draft.users['20210001'] = { userinfo: USER, savedAt: 'now' } })
  const fetchImpl = mockFetch(listingRoutes)
  const env = { store, fetch: fetchImpl, username: () => '20210001' }
  const result = await callTool('ucloud_undone_list', { ctx: fakeCtx({ credentials: CREDENTIALS }), env })
  assert.equal(result.count, 2)
  assert.equal(result.items[0].courseName, '高等数学')
  assert.equal(result.items[0].teachers, '李老师')
  assert.equal(result.items[0].typeName, '作业')
  assert.ok(result.report.includes('第一次作业'))
  assert.ok(result.report.includes('2026-01-01 23:59'))
  const state = await store.read()
  assert.equal(state.homeworks.A1.info.name, '高等数学')
  assert.equal(state.homeworks.A2.info.name, '高等数学')
})

await check('ucloud_undone_list reports an empty term plainly', async () => {
  const store = await tempStore()
  await store.update((draft) => { draft.users['20210001'] = { userinfo: USER, savedAt: 'now' } })
  const fetchImpl = mockFetch([
    { method: 'GET', match: 'site/student/undone', reply: () => json({ success: true, data: { undoneList: [] } }) },
  ])
  const result = await callTool('ucloud_undone_list', {
    ctx: fakeCtx({ credentials: CREDENTIALS }),
    env: { store, fetch: fetchImpl, username: () => '20210001' },
  })
  assert.equal(result.count, 0)
  assert.ok(result.report.includes('（没有未完成的作业）'))
})

await check('ucloud_undone_list surfaces a platform refusal', async () => {
  const store = await tempStore()
  await store.update((draft) => { draft.users['20210001'] = { userinfo: USER, savedAt: 'now' } })
  const fetchImpl = mockFetch([{ method: 'GET', match: 'site/student/undone', reply: () => json({ success: false, msg: '登录已过期' }) }])
  await assert.rejects(
    () => callTool('ucloud_undone_list', { ctx: fakeCtx({ credentials: CREDENTIALS }), env: { store, fetch: fetchImpl, username: () => '20210001' } }),
    (error) => error.code === 'upstream-error' && error.message.includes('登录已过期'),
  )
})

await check('ucloud_homework returns content, course and attachment links', async () => {
  const store = await tempStore()
  await store.update((draft) => { draft.users['20210001'] = { userinfo: USER, savedAt: 'now' } })
  const fetchImpl = mockFetch([
    { method: 'GET', match: 'ykt-site/work/detail', reply: () => json({ success: true, data: {
      assignmentTitle: '第一次作业', assignmentContent: '<p>做 1-3 题</p>', assignmentEndTime: '2026-01-01T23:59:00',
      className: '高等数学', chapterName: '第一章', status: 0, assignmentResource: [{ resourceId: 'R1' }],
    } }) },
    ...listingRoutes.slice(1),
    { method: 'GET', match: 'resource/list/byId', reply: () => json({ success: true, data: [{ storageId: 'S1', name: '题目', ext: 'pdf', id: 'R1' }] }) },
    { method: 'GET', match: 'resource/preview-url', reply: () => json({ data: { previewUrl: 'https://cdn.example/x.pdf' } }) },
  ])
  const result = await callTool('ucloud_homework', {
    ctx: fakeCtx({ credentials: CREDENTIALS }),
    env: { store, fetch: fetchImpl, username: () => '20210001' },
    args: { activityId: 'A1' },
  })
  assert.equal(result.title, '第一次作业')
  assert.equal(result.courseName, '高等数学')
  assert.equal(result.teachers, '李老师')
  assert.ok(result.report.includes('做 1-3 题'), 'HTML tags are stripped')
  assert.equal(result.resources[0].url, 'https://cdn.example/x.pdf')
})

await check('ucloud_homework reports submission state from assignmentStatus, not from a guess', async () => {
  const store = await tempStore()
  await store.update((draft) => { draft.users['20210001'] = { userinfo: USER, savedAt: 'now' } })
  const detailRoute = (data) => ({ method: 'GET', match: 'ykt-site/work/detail', reply: () => json({ success: true, data }) })
  const base = {
    assignmentTitle: '第一次作业', assignmentContent: '<p>x</p>', assignmentEndTime: '2026-01-01T23:59:00',
    className: '高等数学', chapterName: '第一章', assignmentResource: [],
  }
  const env = { store, fetch: null, username: () => '20210001' }
  const run = async (data) => {
    const fetchImpl = mockFetch([detailRoute(data), ...listingRoutes.slice(1)])
    return callTool('ucloud_homework', { ctx: fakeCtx({ credentials: CREDENTIALS }), env: { ...env, fetch: fetchImpl }, args: { activityId: 'A1' } })
  }
  const submitted = await run({ ...base, assignmentStatus: 0, isOvertimeCommit: 1, noSubmitNum: 2, totalNum: 40 })
  assert.ok(submitted.report.includes('assignmentStatus=0（已提交） 已提交 38/40'), submitted.report)
  assert.ok(submitted.report.includes('可逾期交 : 1（不能补交）'))
  assert.equal(submitted.assignmentStatus, 0)
  assert.equal(submitted.totalNum, 40)
  const undone = await run({ ...base, assignmentStatus: 99, isOvertimeCommit: 0, submitTime: '2025-12-31T10:00:00' })
  assert.ok(undone.report.includes('assignmentStatus=99（未提交）'), undone.report)
  assert.ok(undone.report.includes('可逾期交 : 0（可以补交）'))
  assert.ok(undone.report.includes('提交时间 : 2025-12-31 10:00'))
  const graded = await run({ ...base, assignmentStatus: 0, assignmentScore: 88 })
  assert.ok(graded.report.includes('评分     : 88'))
  const ungraded = await run({ ...base, assignmentStatus: 0, assignmentScore: 0 })
  assert.ok(!ungraded.report.includes('评分'), 'a 0 score reads as ungraded, not as a grade')
})

await check('ucloud_homework does not claim a state the platform did not report', async () => {
  const store = await tempStore()
  await store.update((draft) => { draft.users['20210001'] = { userinfo: USER, savedAt: 'now' } })
  const fetchImpl = mockFetch([
    { method: 'GET', match: 'ykt-site/work/detail', reply: () => json({ success: true, data: {
      assignmentTitle: '第一次作业', assignmentContent: '', assignmentEndTime: '2026-01-01T23:59:00', assignmentResource: [],
    } }) },
    ...listingRoutes.slice(1),
  ])
  const result = await callTool('ucloud_homework', {
    ctx: fakeCtx({ credentials: CREDENTIALS }),
    env: { store, fetch: fetchImpl, username: () => '20210001' },
    args: { activityId: 'A1' },
  })
  assert.ok(result.report.includes('平台未返回 assignmentStatus'), result.report)
  assert.ok(result.report.includes('平台未返回 isOvertimeCommit'))
  assert.ok(!result.report.includes('（已提交）') && !result.report.includes('（未提交）'))
})

await check('course lookup compares activity ids loosely across wire types', async () => {
  const store = await tempStore()
  await store.update((draft) => { draft.users['20210001'] = { userinfo: USER, savedAt: 'now' } })
  const numeric = '2025210163'
  const fetchImpl = mockFetch([
    { method: 'GET', match: 'site/list/student/current', reply: () => json({ data: { records: [{ id: 11, siteName: '高等数学', teachers: [{ name: '李老师' }] }] } }) },
    { method: 'GET', match: 'site/student/undone', reply: () => json({ success: true, data: { undoneList: [
      { activityId: numeric, activityName: '大数作业', type: 3, siteId: 11, siteName: '高等数学', endTime: '2026-01-01T23:59:00' },
    ] } }) },
    // The course list reports the id as a JSON number; the undone list reports
    // it as a string. Only a string comparison joins them.
    { method: 'POST', match: 'ykt-site/work/student/list', reply: () => json({ data: { records: [{ id: Number(numeric) }] } }) },
  ])
  const result = await callTool('ucloud_undone_list', {
    ctx: fakeCtx({ credentials: CREDENTIALS }),
    env: { store, fetch: fetchImpl, username: () => '20210001' },
  })
  assert.equal(result.items[0].courseName, '高等数学')
})

await check('ucloud_homework rejects an empty id before any request', async () => {
  const store = await tempStore()
  const fetchImpl = mockFetch([])
  await assert.rejects(
    () => callTool('ucloud_homework', { ctx: fakeCtx(), env: { store, fetch: fetchImpl, username: () => '20210001' }, args: { activityId: ' ' } }),
    (error) => error.code === 'invalid-arguments',
  )
  assert.equal(fetchImpl.calls.length, 0)
})

await check('ucloud_search locates the owning course', async () => {
  const store = await tempStore()
  await store.update((draft) => { draft.users['20210001'] = { userinfo: USER, savedAt: 'now' } })
  const fetchImpl = mockFetch(listingRoutes.slice(1))
  const result = await callTool('ucloud_search', {
    ctx: fakeCtx({ credentials: CREDENTIALS }),
    env: { store, fetch: fetchImpl, username: () => '20210001' },
    args: { activityId: 'A1', keyword: '第一次作业' },
  })
  assert.equal(result.found, true)
  assert.equal(result.course.name, '高等数学')
})

await check('ucloud_upload uploads the downloaded bytes as multipart', async () => {
  const store = await tempStore()
  await store.update((draft) => { draft.users['20210001'] = { userinfo: USER, savedAt: 'now' } })
  const fetchImpl = mockFetch([
    { method: 'GET', match: 'https://files.example/a.pdf', reply: () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': '4' } }) },
    { method: 'POST', match: 'resource/upload/biz', reply: ({ init }) => {
      const body = init.body
      assert.ok(body instanceof FormData, 'the upload is multipart form data')
      assert.equal(body.get('userId'), 'U1')
      assert.equal(body.get('bizType'), '3')
      const file = body.get('file')
      assert.equal(file.name, 'a.pdf')
      assert.equal(file.type, 'application/pdf')
      assert.equal(file.size, 4)
      return json({ success: true, data: 'RID-1' })
    } },
    { method: 'GET', match: 'resource/preview-url', reply: () => json({ data: { previewUrl: 'https://cdn.example/a.pdf' } }) },
  ])
  const result = await callTool('ucloud_upload', {
    ctx: fakeCtx({ credentials: CREDENTIALS }),
    env: { store, fetch: fetchImpl, username: () => '20210001' },
    args: { url: 'https://files.example/a.pdf', filename: 'a.pdf', mimeType: 'application/pdf' },
  })
  assert.equal(result.resourceId, 'RID-1')
  assert.equal(result.previewUrl, 'https://cdn.example/a.pdf')
})

await check('ucloud_upload aborts a chunked download that crosses the ceiling', async () => {
  const store = await tempStore()
  await store.update((draft) => { draft.users['20210001'] = { userinfo: USER, savedAt: 'now' } })
  let pulled = 0
  const chunk = new Uint8Array(1024)
  const stream = new ReadableStream({
    pull(controller) {
      pulled += 1
      if (pulled > 64) { controller.close(); return }
      controller.enqueue(chunk)
    },
  })
  const fetchImpl = mockFetch([
    // No content-length: only the incremental read can stop this.
    { method: 'GET', match: 'https://files.example/stream.bin', reply: () => new Response(stream, { status: 200, headers: { 'content-type': 'application/octet-stream' } }) },
  ])
  await assert.rejects(
    () => callTool('ucloud_upload', {
      ctx: fakeCtx({ credentials: CREDENTIALS }),
      env: { store, fetch: fetchImpl, username: () => '20210001', maxUploadBytes: 4096 },
      args: { url: 'https://files.example/stream.bin', filename: 'stream.bin' },
    }),
    (error) => error.code === 'file-too-large',
  )
  assert.ok(pulled < 64, `the read stopped early (pulled ${pulled} chunks)`)
  assert.ok(!fetchImpl.calls.some((call) => call.url.includes('upload/biz')), 'nothing was uploaded')
})

await check('ucloud_upload keeps a successful upload when only the preview lookup fails', async () => {
  const store = await tempStore()
  await store.update((draft) => { draft.users['20210001'] = { userinfo: USER, savedAt: 'now' } })
  const fetchImpl = mockFetch([
    { method: 'GET', match: 'https://files.example/d.pdf', reply: () => new Response(new Uint8Array([1, 2]), { status: 200 }) },
    { method: 'POST', match: 'resource/upload/biz', reply: () => json({ success: true, data: 'RID-9' }) },
    { method: 'GET', match: 'resource/preview-url', reply: () => json({ msg: '预览服务不可用' }, 500) },
  ])
  const result = await callTool('ucloud_upload', {
    ctx: fakeCtx({ credentials: CREDENTIALS }),
    env: { store, fetch: fetchImpl, username: () => '20210001' },
    args: { url: 'https://files.example/d.pdf', filename: 'd.pdf' },
  })
  assert.equal(result.resourceId, 'RID-9')
  assert.equal(result.previewUrl, '', 'no preview URL is invented')
  assert.ok(result.report.includes('RID-9'))
  assert.ok(!result.report.includes('预览地址'))
})

await check('ucloud_upload refuses a file over the size ceiling', async () => {
  const store = await tempStore()
  await store.update((draft) => { draft.users['20210001'] = { userinfo: USER, savedAt: 'now' } })
  const fetchImpl = mockFetch([
    { method: 'GET', match: 'https://files.example/big.bin', reply: () => new Response(new Uint8Array(4096), { status: 200, headers: { 'content-length': '4096' } }) },
  ])
  await assert.rejects(
    () => callTool('ucloud_upload', {
      ctx: fakeCtx({ credentials: CREDENTIALS }),
      env: { store, fetch: fetchImpl, username: () => '20210001', maxUploadBytes: 1024 },
      args: { url: 'https://files.example/big.bin', filename: 'big.bin' },
    }),
    (error) => error.code === 'file-too-large',
  )
  assert.ok(!fetchImpl.calls.some((call) => call.url.includes('upload/biz')), 'nothing was uploaded')
})

await check('uploadFromUrl maps an upload refusal to upload-failed', async () => {
  const fetchImpl = mockFetch([
    { method: 'GET', match: 'https://files.example/c.pdf', reply: () => new Response(new Uint8Array([1]), { status: 200 }) },
    { method: 'POST', match: 'resource/upload/biz', reply: () => json({ success: false, msg: '空间不足' }, 200) },
  ])
  await assert.rejects(
    () => uploadFromUrl(USER, { url: 'https://files.example/c.pdf', filename: 'c.pdf' }, { fetch: fetchImpl }),
    (error) => error.code === 'upload-failed' && error.message.includes('空间不足'),
  )
})

await check('ucloud_submit posts the platform body shape', async () => {
  const store = await tempStore()
  await store.update((draft) => { draft.users['20210001'] = { userinfo: USER, savedAt: 'now' } })
  const fetchImpl = mockFetch([
    { method: 'POST', match: 'ykt-site/work/submit', reply: ({ init }) => {
      const body = JSON.parse(init.body)
      assert.deepEqual(body, {
        attachmentIds: ['RID-1'], assignmentContent: '答案', assignmentId: 'A1',
        assignmentType: 0, userId: 'U1', groupId: '', commitId: '',
      })
      return json({ success: true })
    } },
  ])
  const result = await callTool('ucloud_submit', {
    ctx: fakeCtx({ credentials: CREDENTIALS }),
    env: { store, fetch: fetchImpl, username: () => '20210001' },
    args: { assignmentId: 'A1', content: '答案', attachmentIds: ['RID-1'] },
  })
  assert.equal(result.success, true)
})

await check('ucloud_submit surfaces a platform refusal', async () => {
  const store = await tempStore()
  await store.update((draft) => { draft.users['20210001'] = { userinfo: USER, savedAt: 'now' } })
  const fetchImpl = mockFetch([{ method: 'POST', match: 'ykt-site/work/submit', reply: () => json({ success: false, msg: '已提交' }) }])
  await assert.rejects(
    () => callTool('ucloud_submit', { ctx: fakeCtx({ credentials: CREDENTIALS }), env: { store, fetch: fetchImpl, username: () => '20210001' }, args: { assignmentId: 'A1' } }),
    (error) => error.code === 'submit-failed' && error.message.includes('已提交'),
  )
})

await check('an account credential never stands in for the settings section', async () => {
  const fetchImpl = mockFetch([])
  const result = await callTool('ucloud_account', {
    ctx: fakeCtx({ credentials: { UCLOUD_USERNAME: '20210001', UCLOUD_PASSWORD: 'pw' } }),
    env: { store: await tempStore(), fetch: fetchImpl, username: () => '' },
  })
  assert.equal(result.configured, false)
  assert.equal(result.username, '')
  assert.ok(result.report.includes('尚未配置完整'))
})

await check('ucloud_account reports the configuration without logging in', async () => {
  const fetchImpl = mockFetch([])
  const result = await callTool('ucloud_account', {
    ctx: fakeCtx({ credentials: { UCLOUD_PASSWORD: 'pw', UCLOUD_OCR_TOKEN: 'ocr' } }),
    env: { store: await tempStore(), fetch: fetchImpl, username: () => '20210001' },
  })
  assert.equal(result.configured, true)
  assert.equal(result.verified, false)
  assert.equal(fetchImpl.calls.length, 0)
})

await check('ucloud_account verify=true proves the credentials by logging in', async () => {
  const store = await tempStore()
  const fetchImpl = mockFetch(loginRoutes())
  const result = await callTool('ucloud_account', {
    ctx: fakeCtx({ credentials: CREDENTIALS }),
    env: { store, fetch: fetchImpl, username: () => '20210001' },
    args: { verify: true },
  })
  assert.equal(result.verified, true)
  assert.equal(result.realName, '张三')
  assert.deepEqual(result.roles, ['学生'])
  assert.ok(result.report.includes('张三'))
})

await check('ucloud_account verify=true reports an unconfigured account instead of logging in', async () => {
  const store = await tempStore()
  const fetchImpl = mockFetch([])
  await assert.rejects(
    () => callTool('ucloud_account', { ctx: fakeCtx(), env: { store, fetch: fetchImpl, username: () => '' }, args: { verify: true } }),
    (error) => error.code === 'missing-username',
  )
  assert.equal(fetchImpl.calls.length, 0)
})

await check('every tool declares an output schema, timeout and JSON-schema parameters', async () => {
  const definitions = toolDefinitions(fakeCtx(), { store: await tempStore(), fetch: mockFetch([]), username: () => '' })
  assert.deepEqual(definitions.map((tool) => tool.name), [
    'ucloud_undone_list', 'ucloud_works', 'ucloud_homework', 'ucloud_search',
    'ucloud_upload', 'ucloud_submit', 'ucloud_account', 'ucloud_login',
  ])
  for (const tool of definitions) {
    assert.equal(tool.parameters.type, 'object', `${tool.name} parameters are object-rooted`)
    assert.equal(tool.parameters.additionalProperties, false, `${tool.name} closes its parameter object`)
    assert.ok(Array.isArray(tool.parameters.required), `${tool.name} declares required fields`)
    assert.equal(typeof tool.output.render, 'function', `${tool.name} renders its output`)
    assert.equal(tool.output.schema.type, 'object', `${tool.name} returns an object`)
    assert.ok(Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0, `${tool.name} declares a timeout`)
  }
})

await check('credential lookups go through the network only once per call chain', async () => {
  const store = await tempStore()
  await store.update((draft) => { draft.users['20210001'] = { userinfo: USER, savedAt: 'now' } })
  const fetchImpl = mockFetch(listingRoutes)
  await callTool('ucloud_undone_list', { ctx: fakeCtx({ credentials: CREDENTIALS }), env: { store, fetch: fetchImpl, username: () => '20210001' } })
  await callTool('ucloud_undone_list', { ctx: fakeCtx({ credentials: CREDENTIALS }), env: { store, fetch: fetchImpl, username: () => '20210001' } })
  assert.ok(!fetchImpl.calls.some((call) => call.url.includes('authserver')), 'no re-login for a cached token')
})

/* ------------------------------------------------------------------ *
 * Settings-page route
 * ------------------------------------------------------------------ */

/** A minimal req/res pair; `req` is an async iterable of body chunks. */
function routeHarness({ body = '', url = VERIFY_PATH, method = 'POST', headers = {} } = {}) {
  const chunks = body.length > 0 ? [Buffer.from(body)] : []
  const req = {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
  const response = { status: undefined, headers: undefined, body: undefined, ended: false }
  const res = {
    writeHead(status, outgoing) { response.status = status; response.headers = outgoing },
    end(payload) { response.body = payload; response.ended = true },
  }
  return { req, res, response }
}

await check('the verify route fails closed without the browser trust fence', async () => {
  const store = await tempStore()
  const handler = createRouteHandler(fakeCtx(), { store, fetch: mockFetch([]), username: () => '20210001' })
  const { req, res, response } = routeHarness()
  await handler(req, res)
  assert.equal(response.status, 503)
  assert.equal(response.body, undefined, 'no body is written for a fenced request')
})

await check('the verify route refuses a rejected browser session', async () => {
  const store = await tempStore()
  const handler = createRouteHandler(fakeCtx({ connection: { requestRejection: () => 403 } }), { store, fetch: mockFetch([]), username: () => '20210001' })
  const { req, res, response } = routeHarness()
  await handler(req, res)
  assert.equal(response.status, 403)
})

await check('the verify route answers 404 for any other endpoint or method', async () => {
  const store = await tempStore()
  const handler = createRouteHandler(fakeCtx({ connection: { requestRejection: () => undefined } }), { store, fetch: mockFetch([]), username: () => '20210001' })
  for (const request of [{ url: `${ROUTE_PREFIX}/other` }, { url: VERIFY_PATH, method: 'GET' }]) {
    const { req, res, response } = routeHarness(request)
    await handler(req, res)
    assert.equal(response.status, 404)
    assert.equal(JSON.parse(response.body).error.code, 'not-found')
  }
})

await check('the verify route logs in and returns the account name, never a credential', async () => {
  const store = await tempStore()
  const fetchImpl = mockFetch(loginRoutes())
  const handler = createRouteHandler(fakeCtx({ connection: { requestRejection: () => undefined }, credentials: CREDENTIALS }), {
    store,
    fetch: fetchImpl,
    username: () => '20210001',
  })
  const { req, res, response } = routeHarness({ body: '{}' })
  await handler(req, res)
  assert.equal(response.status, 200)
  const payload = JSON.parse(response.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.value.realName, '张三')
  assert.deepEqual(payload.value.roles, ['学生'])
  assert.ok(!response.body.includes('pw'), 'the password never rides a response')
  assert.ok(!response.body.includes('ocr'), 'the OCR token never rides a response')
})

await check('the verify route maps a credential failure to a 400 with its message', async () => {
  const store = await tempStore()
  const handler = createRouteHandler(fakeCtx({ connection: { requestRejection: () => undefined } }), { store, fetch: mockFetch([]), username: () => '' })
  const { req, res, response } = routeHarness()
  await handler(req, res)
  assert.equal(response.status, 400)
  const payload = JSON.parse(response.body)
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'missing-username')
  assert.ok(payload.error.message.includes('设置 → 插件'))
})

await check('the verify route bounds the request body', async () => {
  const store = await tempStore()
  const handler = createRouteHandler(fakeCtx({ connection: { requestRejection: () => undefined } }), { store, fetch: mockFetch([]), username: () => '20210001' })
  const { req, res, response } = routeHarness({ body: 'x'.repeat(32 * 1024) })
  await handler(req, res)
  assert.equal(response.status, 400)
  assert.equal(JSON.parse(response.body).error.code, 'invalid-arguments')
})

await check('searchCourses groups by activity type and stops early', async () => {
  const fetchImpl = mockFetch([
    ...listingRoutes,
    { method: 'GET', match: 'site/list/student/current', reply: () => json({ data: { records: [{ id: 11, siteName: '高等数学', teachers: [{ name: '李老师' }] }] } }) },
    { method: 'GET', match: 'survey/page/todo', reply: () => json({ data: { records: [] } }) },
  ])
  const found = await searchCourses({ user_id: 'U1', access_token: 't' }, [
    { activityId: 'A1', type: 3 },
    { activityId: 'A2', type: 4 },
    { activityId: 'A9', type: 2 },
  ], { fetch: fetchImpl })
  assert.deepEqual(Object.keys(found).sort(), ['A1', 'A2'])
  assert.equal(found.A1.name, '高等数学')
})

/* ------------------------------------------------------------------ *
 * CLI parity: works, upload from a path, raw detail, captcha, triage
 * ------------------------------------------------------------------ */

await check('ucloud_works splits every course into submitted and unsubmitted', async () => {
  const store = await tempStore()
  await store.update((draft) => { draft.users['20210001'] = { userinfo: USER, savedAt: 'now' } })
  const fetchImpl = mockFetch([
    { method: 'GET', match: 'site/list/student/current', reply: () => json({ data: { records: [
      { id: 11, siteName: '高等数学', teachers: [{ name: '李老师' }] },
      { id: 12, siteName: '信号分析', teachers: [{ name: '王老师' }] },
    ] } }) },
    { method: 'POST', match: 'ykt-site/work/student/list', reply: ({ init }) => {
      const siteId = JSON.parse(init.body).siteId
      return json({ data: { records: siteId === 11
        ? [{ id: 'A1', assignmentTitle: '第一次作业', chapterName: '第一章', assignmentEndTime: '2026-01-01T23:59:00', submitTime: '2025-12-30T09:00:00' },
           { id: 'A2', assignmentTitle: '第二次作业', assignmentEndTime: '2026-02-01T23:59:00' }]
        : [{ id: 'B1', assignmentTitle: '思考题', assignmentEndTime: '2026-03-01T23:59:00' }] } })
    } },
  ])
  const result = await callTool('ucloud_works', {
    ctx: fakeCtx({ credentials: CREDENTIALS }),
    env: { store, fetch: fetchImpl, username: () => '20210001' },
    args: { filter: 'all' },
  })
  assert.equal(result.courses, 2)
  assert.equal(result.submittedCount, 1)
  assert.equal(result.unsubmittedCount, 2)
  assert.equal(result.submitted[0].activityId, 'A1')
  assert.ok(result.report.includes('已提交 1 份'))
  assert.ok(result.report.includes('未提交 2 份'))
  assert.ok(result.report.includes('id: A2'))
})

await check('ucloud_upload from a local path keeps the file\'s own name and MIME', async () => {
  const store = await tempStore()
  await store.update((draft) => { draft.users['20210001'] = { userinfo: USER, savedAt: 'now' } })
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-ucloud-file-'))
  const file = path.join(dir, '第二周书面作业.pdf')
  await writeFile(file, Buffer.from('%PDF-1.4 fake'))
  const fetchImpl = mockFetch([
    { method: 'POST', match: 'resource/upload/biz', reply: ({ init }) => {
      const body = init.body
      assert.equal(body.get('userId'), 'U1')
      const uploaded = body.get('file')
      assert.equal(uploaded.name, '第二周书面作业.pdf', 'the attachment keeps its original filename')
      assert.equal(uploaded.type, 'application/pdf', 'the MIME type comes from the extension')
      return json({ success: true, data: 'RID-LOCAL' })
    } },
    { method: 'GET', match: 'resource/preview-url', reply: () => json({ data: { previewUrl: 'https://cdn.example/local.pdf' } }) },
  ])
  const result = await callTool('ucloud_upload', {
    ctx: fakeCtx({ credentials: CREDENTIALS }),
    env: { store, fetch: fetchImpl, username: () => '20210001' },
    args: { path: file },
  })
  assert.equal(result.resourceId, 'RID-LOCAL')
  assert.equal(result.filename, '第二周书面作业.pdf')
  assert.equal(result.mimeType, 'application/pdf')
})

await check('ucloud_upload refuses both or neither source', async () => {
  const store = await tempStore()
  await store.update((draft) => { draft.users['20210001'] = { userinfo: USER, savedAt: 'now' } })
  const env = { store, fetch: mockFetch([]), username: () => '20210001' }
  for (const args of [{}, { url: 'https://files.example/a.pdf', path: '/tmp/a.pdf' }]) {
    await assert.rejects(
      () => callTool('ucloud_upload', { ctx: fakeCtx({ credentials: CREDENTIALS }), env, args }),
      (error) => error.code === 'invalid-arguments',
    )
  }
})

await check('ucloud_homework raw=true dumps every platform field, filterable', async () => {
  const store = await tempStore()
  await store.update((draft) => { draft.users['20210001'] = { userinfo: USER, savedAt: 'now' } })
  const fetchImpl = mockFetch([{ method: 'GET', match: 'ykt-site/work/detail', reply: () => json({ success: true, data: {
    assignmentTitle: '第一次作业', assignmentContent: '<p>做 1-3 题</p>', className: '高等数学', assignmentStatus: 0, key: 'abc',
  } }) }])
  const env = { store, fetch: fetchImpl, username: () => '20210001' }
  const all = await callTool('ucloud_homework', { ctx: fakeCtx({ credentials: CREDENTIALS }), env, args: { activityId: 'A1', raw: true } })
  assert.ok(all.report.includes('assignmentTitle'), all.report)
  assert.ok(all.report.includes('className'), all.report)
  assert.deepEqual(all.fields, ['assignmentContent', 'assignmentStatus', 'assignmentTitle', 'className', 'key'])
  assert.equal(all.raw.className, '高等数学')
  const filtered = await callTool('ucloud_homework', { ctx: fakeCtx({ credentials: CREDENTIALS }), env, args: { activityId: 'A1', raw: true, fields: ['assignment'] } })
  assert.ok(filtered.report.includes('assignmentTitle'))
  assert.ok(!filtered.report.includes('className'), filtered.report)
})

await check('ucloud_undone_list triages urgent, backlog and dead work', async () => {
  const store = await tempStore()
  await store.update((draft) => { draft.users['20210001'] = { userinfo: USER, savedAt: 'now' } })
  // The platform sends local (Beijing) timestamps with no zone suffix.
  const inHours = (hours) => {
    const date = new Date(Date.now() + hours * 3_600_000)
    const pad = (value) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  }
  const fetchImpl = mockFetch([
    { method: 'GET', match: 'site/student/undone', reply: () => json({ success: true, data: {
      siteNum: 2, undoneNum: 3,
      undoneList: [
        { activityId: 'URGENT', activityName: '明天早上的作业', type: 3, siteId: 11, siteName: '高等数学', endTime: inHours(6) },
        { activityId: 'LATER', activityName: '下周的作业', type: 3, siteId: 11, siteName: '高等数学', endTime: inHours(240) },
        { activityId: 'DEAD', activityName: '过期作业', type: 3, siteId: 12, siteName: '信号分析', endTime: inHours(-48) },
      ],
    } }) },
    { method: 'GET', match: 'site/list/student/current', reply: () => json({ data: { records: [
      { id: 11, siteName: '高等数学', teachers: [{ name: '李老师' }] },
      { id: 12, siteName: '信号分析', teachers: [{ name: '王老师' }] },
    ] } }) },
    { method: 'POST', match: 'ykt-site/work/student/list', reply: () => json({ data: { records: [{ id: 'URGENT' }, { id: 'LATER' }, { id: 'DEAD' }] } }) },
    { method: 'GET', match: 'ykt-site/work/detail', reply: ({ url }) => json({ success: true, data: url.includes('DEAD')
      ? { assignmentTitle: '过期作业', assignmentEndTime: inHours(-48), isOvertimeCommit: 1, assignmentStatus: 99 }
      : { assignmentTitle: 'x', assignmentEndTime: inHours(6), isOvertimeCommit: 0, assignmentStatus: 99 } }) },
  ])
  const result = await callTool('ucloud_undone_list', {
    ctx: fakeCtx({ credentials: CREDENTIALS }),
    env: { store, fetch: fetchImpl, username: () => '20210001' },
  })
  assert.equal(result.count, 3)
  assert.equal(result.urgentCount, 1)
  assert.equal(result.expiredBlockedCount, 1)
  assert.equal(result.todoCount, 2)
  assert.ok(result.report.includes('🔴 24 小时内截止（1 项'), result.report)
  assert.ok(result.report.includes('待办（1 项）'))
  assert.ok(result.report.includes('⚪ 已过期且不可补交（1 项'))
  assert.ok(result.report.includes('🔴 24 小时内截止'))
  const urgent = result.items.find((item) => item.activityId === 'URGENT')
  assert.equal(urgent.deadlineState, 'urgent')
  const dead = result.items.find((item) => item.activityId === 'DEAD')
  assert.equal(dead.canLateSubmit, false)
  assert.equal(dead.isOvertimeCommit, 1)
})

await check('a captcha becomes a saved image plus an ucloud_login retry', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-ucloud-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const store = await tempStore()
    const fetchImpl = mockFetch([
      ...loginRoutes({ captcha: true }),
      { method: 'GET', match: 'authserver/captcha', reply: () => new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } }) },
    ])
    const env = { store, fetch: fetchImpl, username: () => '20210001' }
    const ctx = fakeCtx({ credentials: CREDENTIALS })
    const account = await callTool('ucloud_account', { ctx, env, args: { verify: true } })
    assert.equal(account.verified, false)
    assert.equal(account.captchaRequired, true)
    assert.ok(account.captchaId, 'a captcha id is handed back')
    assert.ok(existsSync(account.imagePath), 'the image is on disk')
    assert.ok(account.report.includes('ucloud_login'), account.report)

    const done = await callTool('ucloud_login', { ctx, env, args: { captchaId: account.captchaId, captcha: 'a1b2' } })
    assert.equal(done.verified, true)
    assert.equal(done.realName, '张三')
    const formPosts = fetchImpl.calls.filter((call) => call.method === 'POST' && call.url.includes('authserver/login'))
    assert.equal(formPosts.length, 1, 'exactly one CAS form post, and it carried the answer')
    assert.ok(String(formPosts[0].init.body).includes('captcha=a1b2'))
    assert.equal(existsSync(account.imagePath), false, 'the image is cleaned up after use')

    await assert.rejects(
      () => callTool('ucloud_login', { ctx, env, args: { captchaId: 'nope', captcha: 'x' } }),
      (error) => error.code === 'captcha-expired',
    )
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

/* ------------------------------------------------------------------ *
 * Plugin entry wiring
 * ------------------------------------------------------------------ */

/** A cordis-shaped context recording what `apply` registers. */
function harnessContext(services = {}) {
  const registered = { tools: [], routes: [], effects: 0, events: new Map() }
  const scoped = {
    effect(callback) {
      registered.effects += 1
      const dispose = callback()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    tools: { register(definition) { registered.tools.push(definition); return () => {} } },
    webServer: { register(route) { registered.routes.push(route); return () => {} } },
    get(name) { return services[name] },
  }
  const ctx = {
    inject(needed, callback) {
      assert.ok(['tools', 'webServer'].includes(needed[0]), `unexpected injection: ${needed[0]}`)
      callback(scoped)
      return () => {}
    },
    on(name, listener) { registered.events.set(name, listener) },
    get(name) { return services[name] },
  }
  return { ctx, registered }
}

await check('apply injects tools and webServer and registers the real surfaces', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-bupt-ucloud-home-'))
  process.env.DSH_HOME = dir
  try {
    const { ctx, registered } = harnessContext()
    const entry = await import('../index.js')
    const config = { username: { get: () => '20210001' } }
    entry.apply(ctx, config)
    assert.deepEqual(registered.tools.map((tool) => tool.name), [
      'ucloud_undone_list', 'ucloud_works', 'ucloud_homework', 'ucloud_search',
      'ucloud_upload', 'ucloud_submit', 'ucloud_account', 'ucloud_login',
    ])
    assert.equal(registered.routes.length, 1)
    assert.equal(registered.routes[0].kind, 'prefix')
    assert.equal(registered.routes[0].path, '/dsh-bupt-ucloud')
    assert.equal(typeof registered.routes[0].handler, 'function')
    assert.ok(registered.events.has('credentials/reference-updated'))
    assert.equal(registered.effects, 2, 'one effect per injected surface')

    // The registered tool reads 学号 from the live config and 密码 from the seam.
    const account = registered.tools.find((tool) => tool.name === 'ucloud_account')
    const result = await account.execute({}, { signal: new AbortController().signal })
    assert.equal(result.configured, false, 'no password is configured yet')
    assert.equal(result.username, '20210001')
    assert.ok(result.report.includes('设置 → 插件'))
  } finally {
    delete process.env.DSH_HOME
  }
})

await check('the plugin caches tokens in its own profile\'s state file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-bupt-ucloud-home-'))
  process.env.DSH_HOME = dir
  const realFetch = globalThis.fetch
  try {
    const { ctx, registered } = harnessContext({ profileContext: { name: 'web' }, credentials: { resolve: async (ref) => (ref === 'UCLOUD_PASSWORD' ? { value: 'pw' } : undefined) } })
    const entry = await import('../index.js')
    entry.apply(ctx, { username: { get: () => '20210001' } })
    globalThis.fetch = mockFetch(loginRoutes())
    const account = registered.tools.find((tool) => tool.name === 'ucloud_account')
    const result = await account.execute({ verify: true }, { signal: new AbortController().signal })
    assert.equal(result.verified, true)
    const scoped = await new StateStore(path.join(dir, 'ucloud', 'web.json')).read()
    assert.equal(scoped.users['20210001'].userinfo.real_name, '张三', 'the token landed in the profile file')
    assert.ok(!existsSync(path.join(dir, 'ucloud', 'state.json')), 'no profile-less document was written')
  } finally {
    globalThis.fetch = realFetch
    delete process.env.DSH_HOME
  }
})

await check('a rotated credential drops the cached platform token', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-bupt-ucloud-home-'))
  process.env.DSH_HOME = dir
  try {
    const { ctx, registered } = harnessContext()
    const entry = await import('../index.js')
    entry.apply(ctx, { username: { get: () => '20210001' } })
    const file = path.join(dir, 'ucloud', 'state.json')
    const store = new StateStore(file)
    await store.update((draft) => {
      draft.users['20210001'] = { userinfo: { access_token: jwt(600), refresh_token: jwt(7200), user_id: 'U1' } }
      draft.homeworks.A1 = { info: { name: '高等数学' }, savedAt: 'now' }
    })
    await registered.events.get('credentials/reference-updated')('UCLOUD_OCR_TOKEN')
    const state = await store.read()
    assert.deepEqual(Object.keys(state.users), [], 'the cached token was dropped')
    assert.equal(state.homeworks.A1.info.name, '高等数学', 'the course cache survived')
    await registered.events.get('credentials/reference-updated')('SOMETHING_ELSE')
    assert.deepEqual(Object.keys((await store.read()).users), [])
  } finally {
    delete process.env.DSH_HOME
  }
})

await check('a missing tools or webServer service leaves the plugin inert, not broken', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-bupt-ucloud-home-'))
  process.env.DSH_HOME = dir
  try {
    const entry = await import('../index.js')
    // A context whose injections never fire: apply must not throw.
    const ctx = { inject: () => () => {}, on: () => {}, get: () => undefined }
    entry.apply(ctx, { username: { get: () => '' } })
  } finally {
    delete process.env.DSH_HOME
  }
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) console.error(`failed: ${failures.join(', ')}`)
