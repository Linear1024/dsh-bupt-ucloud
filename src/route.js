/**
 * The one browser-facing route the plugin registers: a credential check for the
 * settings page.
 *
 * The page already has everything it needs to *write* the account (the shared
 * settings form for 学号, the credentials seam for 密码 and the OCR token), so
 * this route exists for the one thing a browser cannot do: prove that the
 * stored credentials actually log in. It is fenced by the deployment's own
 * browser trust check, exactly like every `/api` call, and it never returns a
 * credential — only the account name the platform reported.
 *
 * @module dsh-ucloud/route
 */

import { UcloudError, getToken } from './ucloud.js'
import { readAccount } from './tools.js'

/** Route prefix the settings page calls. */
export const ROUTE_PREFIX = '/dsh-ucloud'

/** Exact endpoint of the login check. */
export const VERIFY_PATH = `${ROUTE_PREFIX}/verify`

/** Largest request body this route will read. */
const MAX_BODY_BYTES = 16 * 1024

/** Write one JSON response and end the exchange. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Apply the deployment's browser trust fence to one route request.
 *
 * `ctx.connection.requestRejection()` is the Host/Origin plus browser-session
 * check every `/api` call already passes; a route a plugin registers is not
 * covered by it automatically, so a missing fence fails closed.
 *
 * @param ctx - plugin context.
 * @param req - incoming request.
 * @returns a rejection status, or undefined when the request may proceed.
 */
function trustRejection(ctx, req) {
  let connection
  try {
    connection = ctx.get('connection')
  } catch {
    connection = undefined
  }
  if (connection === undefined || typeof connection.requestRejection !== 'function') return 503
  try {
    const rejection = connection.requestRejection({ headers: req.headers })
    return rejection === undefined ? undefined : rejection
  } catch {
    return 403
  }
}

/** Read and discard the request body, bounded. */
async function drainBody(req) {
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new UcloudError('invalid-arguments', '请求体过大')
  }
}

/**
 * Build the route handler.
 * @param ctx - plugin context.
 * @param env - plugin wiring (`store`, `fetch`, `username()`).
 * @returns the `webServer` prefix handler.
 */
export function createRouteHandler(ctx, env) {
  return async (req, res) => {
    const rejection = trustRejection(ctx, req)
    if (rejection !== undefined) {
      try { res.writeHead(rejection); res.end() } catch {}
      return
    }
    const url = String(req.url ?? '')
    const pathname = url.split('?')[0].replace(/\/$/, '')
    if (req.method !== 'POST' || pathname !== VERIFY_PATH) {
      sendJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown endpoint' } })
      return
    }
    try {
      await drainBody(req)
      const account = await readAccount(ctx, env)
      const userinfo = await getToken({ ...account, store: env.store, fetch: env.fetch, force: true })
      const roles = Array.isArray(userinfo.roles) ? userinfo.roles.map((role) => role.roleName) : []
      sendJson(res, 200, {
        ok: true,
        value: {
          userName: userinfo.user_name ?? account.username,
          realName: userinfo.real_name ?? '',
          roles,
        },
      })
    } catch (error) {
      const known = error instanceof UcloudError
      const code = known ? error.code : 'operation-error'
      const message = known ? error.message : '登录校验失败，请查看 DSH 日志获取详情。'
      sendJson(res, known ? 400 : 500, { ok: false, error: { code, message } })
    }
  }
}
