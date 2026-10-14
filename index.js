/**
 * `dsh-bupt-ucloud` — Host half.
 *
 * Wraps the [YouXam/ucloud](https://github.com/YouXam/ucloud) worker (GPL-3.0)
 * as an in-process DSH plugin: 学号 lives in this plugin's own settings section
 * (edited on the Plugins page), 密码 and the optional 验证码识别令牌 live in the
 * deployment's credential store, and the platform itself is reached with the
 * ported client in `src/ucloud.js`.
 *
 * Two surfaces share one account resolution, so the page and the model can
 * never disagree about which account is configured:
 *
 * | Surface | Where |
 * |---|---|
 * | Agent tools | `ucloud_undone_list`, `ucloud_homework`, `ucloud_search`, `ucloud_upload`, `ucloud_submit`, `ucloud_account` |
 * | Web UI | the **教学云** card on Settings → Plugins (`plugins.item`), plus `POST /dsh-bupt-ucloud/verify` for its login check |
 *
 * @module dsh-bupt-ucloud
 */

import z from './vendor/schemastery.js'
import { createRouteHandler, ROUTE_PREFIX } from './src/route.js'
import { StateStore, statePath } from './src/state.js'
import { DEFAULT_MAX_UPLOAD_BYTES, OCR_TOKEN_REF, PASSWORD_REF } from './src/ucloud.js'
import { toolDefinitions } from './src/tools.js'

/** Cordis plugin name used by loader diagnostics; also the settings namespace. */
export const name = 'ucloud'

/**
 * Plugin configuration: the 学号 the tools work as.
 *
 * Volatile so the Plugins page edits it live through its own form; the password
 * and the OCR token are deliberately absent — they are credentials, not
 * configuration, and are addressed by reference from the credential store.
 */
export const Config = z.object({
  username: z.string().volatile(),
})

/**
 * Read one optional service without assuming it is mounted.
 * @param ctx - plugin context.
 * @param name - service name.
 * @returns the service, or undefined.
 */
function safeGet(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/**
 * Register the agent tools and the settings-page route.
 *
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration (volatile values are live).
 */
export function apply(ctx, config) {
  // One state document per profile: two profiles must not share a token cache
  // or race on one file. A context without a profile keeps the plain default.
  const store = new StateStore(statePath(undefined, safeGet(ctx, 'profileContext')?.name))
  const env = {
    store,
    /** Deferred so a test (or a future fetch seam) can replace the global. */
    fetch: (input, init) => globalThis.fetch(input, init),
    maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
    /** The configured 学号, read live from the settings section. */
    username: () => {
      const value = config?.username
      const raw = typeof value?.get === 'function' ? value.get() : value
      return typeof raw === 'string' ? raw : ''
    },
  }

  // A rotated password or OCR token invalidates every cached platform token:
  // the next call logs in again instead of retrying a session the platform may
  // already have revoked.
  try {
    ctx.on('credentials/reference-updated', (ref) => {
      if (ref !== PASSWORD_REF && ref !== OCR_TOKEN_REF) return
      return store.update((draft) => { draft.users = {} }).catch(() => {})
    })
  } catch {
    // An event name this build does not declare simply means no invalidation.
  }

  ctx.inject(['tools'], (scoped) => {
    scoped.effect(() => {
      const disposers = toolDefinitions(scoped, env).map((definition) => scoped.tools.register(definition))
      return () => { for (const dispose of disposers.reverse()) dispose() }
    }, 'ucloud: agent tools')
  })

  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() => scoped.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: createRouteHandler(scoped, env),
    }), 'ucloud: settings-page route')
  })
}

export { DEFAULT_MAX_UPLOAD_BYTES, OCR_TOKEN_REF, PASSWORD_REF, ROUTE_PREFIX, StateStore, statePath }
