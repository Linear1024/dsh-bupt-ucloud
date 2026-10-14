/**
 * Client-half verification: load the real `client.js` bundle into jsdom, mount
 * the registered Plugins-page card with real React and the real settings
 * primitives, and drive it against a stubbed Host.
 *
 * The primitives are the deployed build
 * (`@deepseek-ai/dsh-client-ui-primitives/lib/index.js`), resolved through
 * `tests/loader-hooks.mjs`; the Host is a stub of the services the card consumes
 * (`configForms`, `remote.credentials`) plus the locale and slot registry.
 *
 * Run: node tests/client.test.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { register } from 'node:module'
import path from 'node:path'
import { DEPLOYED_PRIMITIVES, JSDOM as JSDOM_PATH, REACT, REACT_DOM } from './paths.mjs'

register('./loader-hooks.mjs', import.meta.url)

const require = createRequire(import.meta.url)
const React = require(REACT)
const { JSDOM } = require(JSDOM_PATH)

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:3080/',
  pretendToBeVisual: true,
})
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Node = dom.window.Node
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const createRoot = require(`${REACT_DOM}/client`).createRoot
const { act } = require(`${REACT_DOM}/test-utils`)

// The primitives' browser build imports React DOM, whose module scope decides
// whether it can use the DOM at all. Import it only after jsdom is installed,
// or its event system initializes for a document-less environment.
const primitives = await import(DEPLOYED_PRIMITIVES)
assert.equal(typeof primitives.SettingsFormModel, 'function', 'the real primitives loaded')

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

/**
 * The settings-form scope (`SettingsFormScope`) the card stages over, with the
 * Host's own behavior: `mutate` applies the path ops and notifies readers.
 */
function makeScope(options = {}) {
  const writable = options.writable !== false
  let value = { ...(options.value ?? {}) }
  let revision = 1
  const listeners = new Set()
  const mutations = []
  const snapshot = () => ({
    status: options.status ?? 'ready',
    value,
    base: options.base ?? {},
    user: writable ? { ...value } : undefined,
    writable,
    revision,
  })
  return {
    mutations,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: snapshot,
    async mutate(ops) {
      mutations.push(ops.map((op) => ({ ...op })))
      if (!writable) return false
      for (const op of ops) {
        if (op.path[0] === undefined) continue
        if (op.op === 'set') value[op.path[0]] = op.value
        else delete value[op.path[0]]
      }
      revision += 1
      for (const listener of listeners) listener()
      return true
    },
  }
}

/** A stubbed Host: credentials remote, locale, slot registry, effects. */
function makeHost(scope, options = {}) {
  const locale = options.locale ?? 'zh'
  const credentials = {
    UCLOUD_PASSWORD: { configured: false, writable: true, ...(options.password ?? {}) },
    UCLOUD_OCR_TOKEN: { configured: false, writable: true, ...(options.ocr ?? {}) },
  }
  const state = {
    describeCalls: 0,
    setCalls: [],
    dictionaries: {},
    slots: [],
    listeners: new Map(),
  }
  const ctx = {
    effect(callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(_services, callback) { callback(ctx); return () => {} },
    locale: {
      bind(namespace) {
        return (key) => state.dictionaries[namespace]?.[locale]?.[key] ?? key
      },
      register(namespace, dictionaries) { state.dictionaries[namespace] = dictionaries },
    },
    configForms: {
      get(namespace) {
        assert.equal(namespace, 'ucloud', 'the card edits the ucloud namespace')
        return scope
      },
      whileServed(namespaces, register_) {
        assert.deepEqual([...namespaces], ['ucloud'])
        return register_(new Set(namespaces))
      },
    },
    remote: {
      credentials: {
        async describe(refs) {
          state.describeCalls += 1
          return { ok: true, value: Object.fromEntries(refs.map((ref) => [ref, credentials[ref]])) }
        },
        async set(ref, value) {
          state.setCalls.push({ ref, value })
          credentials[ref] = { ...credentials[ref], configured: value.length > 0 }
          return { ok: true }
        },
      },
      $on(event, listener) {
        state.listeners.set(event, listener)
        return () => state.listeners.delete(event)
      },
    },
    slots: {
      inject(_name, callback) { callback(); return () => {} },
      register(options_, component) { state.slots.push({ options: options_, component }); return () => {} },
    },
  }
  return { ctx, state, credentials }
}

/* ------------------------------------------------------------------ *
 * Load the real client bundle
 * ------------------------------------------------------------------ */

let captured = null
dom.window.__ModuleLoader__ = { load: (row) => { captured = row } }
await import(pathToFileURL(path.resolve('client.js')).href)
assert.ok(captured, 'the client bundle registered a factory')
assert.equal(captured.id, 'dsh-bupt-ucloud')

const exports = captured.factory((id) => {
  if (id === 'react') return React
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected module request: ${id}`)
})
assert.ok(exports && typeof exports.apply === 'function')

const flush = async () => { await act(async () => { await Promise.resolve() }) }
const textOf = (container) => container.textContent || ''
// Attribute form: a scoped `#id` query goes through getElementById, which
// answers with the document's first match even when it is outside this container.
const byId = (container, id) => container.querySelector(`[id="${id}"]`)
const buttonWith = (container, needle) => Array.from(container.querySelectorAll('button'))
  .find((node) => (node.textContent || '').includes(needle))
const setValue = (node, value) => {
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(node, value)
  node.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
}

/** Mount the card the bundle registered, with the machinery's own prop shapes. */
async function mountCard({ host, view = 'page' }) {
  const entry = host.state.slots.find((slot) => slot.options.name === 'plugins.bundle.config')
  assert.ok(entry, 'the card registered into plugins.bundle.config')
  const face = entry.options.inject()
  const props = {
    view,
    t: host.ctx.locale.bind(entry.options.locale),
    verifyLogin: face.verifyLogin,
    edit: face.edit,
    resetField: face.resetField,
    save: face.save,
    discard: face.discard,
  }
  for (const [name, store] of Object.entries(face.hooks)) {
    const propName = `use${name[0].toUpperCase()}${name.slice(1)}`
    props[propName] = (selector) => React.useSyncExternalStore(
      (callback) => store.subscribe(callback),
      () => selector(store.getSnapshot()),
    )
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(React.createElement(entry.component, props)) })
  await flush()
  return { entry, root, props, container }
}

async function unmount(root, container) {
  await act(async () => { root.unmount() })
  container.remove()
}

/* ------------------------------------------------------------------ *
 * Bundle and registration
 * ------------------------------------------------------------------ */

await check('the bundle exports apply, inject and NS under the package id', () => {
  assert.deepEqual(exports.inject, ['slots', 'locale', 'remote', 'remote.credentials', 'configForms'])
  assert.equal(exports.NS, 'settings.ucloud')
})

await check('apply registers one dictionary and one bundle-settings entry', () => {
  const host = makeHost(makeScope())
  exports.apply(host.ctx)
  assert.deepEqual(Object.keys(host.state.dictionaries), ['settings.ucloud'])
  assert.ok(host.state.dictionaries['settings.ucloud'].zh.title)
  assert.ok(host.state.dictionaries['settings.ucloud'].en.title)
  assert.equal(host.state.slots.length, 1)
  const entry = host.state.slots[0]
  // The bundle's own page, not the Official group the shipped pages occupy.
  assert.equal(entry.options.name, 'plugins.bundle.config')
  assert.equal(entry.options.key, 'dsh-bupt-ucloud')
  assert.equal(entry.options.locale, 'settings.ucloud')
  assert.equal(entry.options.id, undefined)
  assert.equal(typeof entry.component, 'function')
  assert.equal(exports.BUNDLE_PACKAGE, 'dsh-bupt-ucloud')
})

/* ------------------------------------------------------------------ *
 * The settings form
 * ------------------------------------------------------------------ */

await check('the summary view renders the one-line description', async () => {
  const host = makeHost(makeScope())
  exports.apply(host.ctx)
  const { root, container } = await mountCard({ host, view: 'summary' })
  assert.ok(textOf(container).includes('配置北邮教学云'), textOf(container))
  await unmount(root, container)
})

await check('the page renders 学号, 密码, 验证码令牌 and the login check', async () => {
  const host = makeHost(makeScope())
  exports.apply(host.ctx)
  const { root, container } = await mountCard({ host })
  assert.equal(byId(container, 'plugin-config-ucloud-username').type, 'text')
  assert.equal(byId(container, 'plugin-config-ucloud-password').type, 'password')
  assert.equal(byId(container, 'plugin-config-ucloud-ocr').type, 'password')
  assert.ok(buttonWith(container, '测试登录'))
  assert.ok(textOf(container).includes('未配置密码'))
  assert.ok(textOf(container).includes('学号保存在配置档设置中'))
  await unmount(root, container)
})

await check('学号 seeds from the settings section and saves through the shared form', async () => {
  const scope = makeScope({ value: { username: '20210001' } })
  const host = makeHost(scope)
  exports.apply(host.ctx)
  const { root, container } = await mountCard({ host })
  const input = byId(container, 'plugin-config-ucloud-username')
  assert.equal(input.value, '20210001', 'the stored 学号 renders')
  await act(async () => { setValue(input, '20219999') })
  await act(async () => { buttonWith(container, '保存').click() })
  await flush()
  assert.deepEqual(scope.mutations, [[{ op: 'set', path: ['username'], value: '20219999' }]])
  assert.equal(byId(container, 'plugin-config-ucloud-username').value, '20219999')
  await unmount(root, container)
})

await check('密码 and 验证码令牌 save into the credential store, never into the section', async () => {
  const scope = makeScope()
  const host = makeHost(scope)
  exports.apply(host.ctx)
  const { root, container } = await mountCard({ host })
  await act(async () => { setValue(byId(container, 'plugin-config-ucloud-password'), 's3cret') })
  await act(async () => { setValue(byId(container, 'plugin-config-ucloud-ocr'), 'ocr-token') })
  await act(async () => { buttonWith(container, '保存').click() })
  await flush()
  assert.deepEqual(host.state.setCalls, [
    { ref: 'UCLOUD_PASSWORD', value: 's3cret' },
    { ref: 'UCLOUD_OCR_TOKEN', value: 'ocr-token' },
  ])
  assert.deepEqual(scope.mutations, [], 'no credential is written into the settings section')
  assert.ok(textOf(container).includes('已配置密码'))
  assert.equal(byId(container, 'plugin-config-ucloud-password').value, '', 'a secret never renders back')
  await unmount(root, container)
})

await check('a configured secret is reported as a badge, not as a value', async () => {
  const host = makeHost(makeScope(), { password: { configured: true }, ocr: { configured: true } })
  exports.apply(host.ctx)
  const { root, container } = await mountCard({ host })
  await flush()
  assert.equal(byId(container, 'plugin-config-ucloud-password').value, '')
  assert.ok(textOf(container).includes('已配置密码'))
  assert.ok(textOf(container).includes('已配置'))
  await unmount(root, container)
})

await check('a read-only settings document disables the section and the login check', async () => {
  const host = makeHost(makeScope({ value: { username: '20210001' }, writable: false }))
  exports.apply(host.ctx)
  const { root, container } = await mountCard({ host })
  assert.ok(textOf(container).includes('本部署的设置为只读'))
  assert.equal(byId(container, 'plugin-config-ucloud-username').disabled, true)
  assert.equal(buttonWith(container, '测试登录').disabled, true)
  await unmount(root, container)
})

await check('a read-only credential store disables only the credential controls', async () => {
  const host = makeHost(makeScope({ value: { username: '20210001' } }), { password: { writable: false }, ocr: { writable: false } })
  exports.apply(host.ctx)
  const { root, container } = await mountCard({ host })
  await flush()
  assert.equal(byId(container, 'plugin-config-ucloud-username').disabled, false)
  assert.equal(byId(container, 'plugin-config-ucloud-password').disabled, true)
  assert.equal(byId(container, 'plugin-config-ucloud-ocr').disabled, true)
  await unmount(root, container)
})

await check('an unserved namespace renders the unavailable notice instead of the controls', async () => {
  const host = makeHost(makeScope({ status: 'loading' }))
  exports.apply(host.ctx)
  const { root, container } = await mountCard({ host })
  assert.ok(textOf(container).includes('该插件当前未加载'))
  assert.equal(byId(container, 'plugin-config-ucloud-username'), null)
  await unmount(root, container)
})

await check('the credential invalidation event re-reads the configured badges', async () => {
  const host = makeHost(makeScope())
  exports.apply(host.ctx)
  const { root, container } = await mountCard({ host })
  const before = host.state.describeCalls
  host.credentials.UCLOUD_PASSWORD = { configured: true, writable: true }
  await act(async () => { host.state.listeners.get('credentials/reference-updated')('UCLOUD_PASSWORD') })
  await flush()
  assert.ok(host.state.describeCalls > before, 'the page re-read the credential state')
  assert.ok(textOf(container).includes('已配置密码'))
  await unmount(root, container)
})

/* ------------------------------------------------------------------ *
 * The login check
 * ------------------------------------------------------------------ */

function stubFetch(reply) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return reply()
  }
  return calls
}

await check('测试登录 posts to the plugin route and renders the account name', async () => {
  const host = makeHost(makeScope({ value: { username: '20210001' } }), { password: { configured: true } })
  exports.apply(host.ctx)
  const { root, container } = await mountCard({ host })
  const calls = stubFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true, value: { userName: '20210001', realName: '张三', roles: ['学生'] } }) }))
  await act(async () => { buttonWith(container, '测试登录').click() })
  await flush()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/dsh-bupt-ucloud/verify')
  assert.equal(calls[0].init.method, 'POST')
  assert.ok(textOf(container).includes('登录成功'), textOf(container))
  assert.ok(textOf(container).includes('张三'))
  assert.ok(textOf(container).includes('学生'))
  await unmount(root, container)
})

await check('测试登录 surfaces the Host error message verbatim', async () => {
  const host = makeHost(makeScope({ value: { username: '20210001' } }), { password: { configured: true } })
  exports.apply(host.ctx)
  const { root, container } = await mountCard({ host })
  stubFetch(() => ({ ok: false, status: 400, json: async () => ({ ok: false, error: { code: 'login-failed', message: '登录失败：学号或密码错误' } }) }))
  await act(async () => { buttonWith(container, '测试登录').click() })
  await flush()
  assert.ok(textOf(container).includes('登录失败：学号或密码错误'), textOf(container))
  await unmount(root, container)
})

await check('测试登录 saves a dirty form first, so it always checks what was typed', async () => {
  const host = makeHost(makeScope())
  exports.apply(host.ctx)
  const { root, container } = await mountCard({ host })
  await act(async () => { setValue(byId(container, 'plugin-config-ucloud-password'), 'fresh') })
  const calls = stubFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true, value: { userName: '20210001', realName: '李四', roles: [] } }) }))
  await act(async () => { buttonWith(container, '测试登录').click() })
  await flush()
  assert.deepEqual(host.state.setCalls, [{ ref: 'UCLOUD_PASSWORD', value: 'fresh' }], 'the staged secret was written first')
  assert.equal(calls.length, 1)
  assert.ok(textOf(container).includes('李四'))
  await unmount(root, container)
})

await check('a network failure is reported instead of leaving the button spinning', async () => {
  const host = makeHost(makeScope())
  exports.apply(host.ctx)
  const { root, container } = await mountCard({ host })
  globalThis.fetch = async () => { throw new Error('offline') }
  await act(async () => { buttonWith(container, '测试登录').click() })
  await flush()
  assert.ok(textOf(container).includes('登录校验失败'), textOf(container))
  assert.ok(textOf(container).includes('offline'))
  assert.equal(buttonWith(container, '测试登录').disabled, false, 'the button recovered')
  await unmount(root, container)
})

/* ------------------------------------------------------------------ *
 * Locale
 * ------------------------------------------------------------------ */

await check('an English browser renders the English copy', async () => {
  const host = makeHost(makeScope(), { locale: 'en' })
  exports.apply(host.ctx)
  const { root, container } = await mountCard({ host })
  assert.ok(textOf(container).includes('Student ID'), textOf(container))
  assert.ok(textOf(container).includes('Password'))
  assert.ok(textOf(container).includes('Test sign-in'))
  assert.equal(host.state.slots[0].options.locale, 'settings.ucloud')
  await unmount(root, container)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) console.error(`failed: ${failures.join(', ')}`)
