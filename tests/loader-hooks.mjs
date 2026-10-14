/**
 * ESM loader hooks for the Client-half test.
 *
 * The browser build of `@deepseek-ai/dsh-client-ui-primitives` is an ESM module
 * that imports CSS modules and expects the client module table to supply React,
 * `clsx`, `react-dom` and friends. Node has none of those, so this hook
 * supplies them:
 *
 * - `react`/`react-dom` resolve to the exact builds the test renders with, so
 *   the primitives' hooks and the test's React are one instance;
 * - `*.module.css` becomes an empty module whose default export answers any
 *   class name, which is all a component needs to keep rendering;
 * - every other bare specifier resolves through the package that imports it,
 *   the monorepo build of the same package, or the monorepo's pnpm store.
 */
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { PNPM, DEPLOYED_PRIMITIVES_MANIFEST, REPO_PRIMITIVES_MANIFEST } from './paths.mjs'

const requireDeployed = createRequire(DEPLOYED_PRIMITIVES_MANIFEST)
const requireRepo = createRequire(REPO_PRIMITIVES_MANIFEST)/** React builds the test renders with; the primitives must share them. */
const REACT = {
  react: `${PNPM}/react@18.3.1/node_modules/react/index.js`,
  'react/jsx-runtime': `${PNPM}/react@18.3.1/node_modules/react/jsx-runtime.js`,
  'react/jsx-dev-runtime': `${PNPM}/react@18.3.1/node_modules/react/jsx-dev-runtime.js`,
  'react-dom': `${PNPM}/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/index.js`,
  'react-dom/client': `${PNPM}/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/client.js`,
  'react-dom/test-utils': `${PNPM}/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/test-utils.js`,
}

/** An empty stylesheet module: any class name reads back as itself. */
const CSS_STUB = `const styles = new Proxy({}, { get: (_target, key) => (typeof key === 'string' ? key : undefined) })
export default styles
export { styles }
`

/** Resolve one bare specifier out of the monorepo's pnpm store. */
function resolveFromPnpm(specifier) {
  const parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  const encoded = name.replace('/', '+')
  let entries
  try {
    entries = readdirSync(PNPM)
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.startsWith(`${encoded}@`)) continue
    const base = `${PNPM}/${entry}/node_modules/${name}/package.json`
    try {
      return createRequire(base).resolve(specifier)
    } catch {}
  }
  return undefined
}

/** @param {string} specifier @param {object} context @param {Function} next */
export async function resolve(specifier, context, next) {
  if (REACT[specifier] !== undefined) return { url: pathToFileURL(REACT[specifier]).href, shortCircuit: true }
  if (specifier.endsWith('.module.css') || specifier.endsWith('.css')) {
    return { url: `data:text/javascript,${encodeURIComponent(CSS_STUB)}`, shortCircuit: true }
  }
  try {
    return await next(specifier, context)
  } catch (error) {
    if (specifier.startsWith('.') || specifier.startsWith('node:') || specifier.startsWith('data:') || specifier.startsWith('file:')) throw error
    for (const require of [requireDeployed, requireRepo]) {
      try {
        return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true }
      } catch {}
    }
    const fromPnpm = resolveFromPnpm(specifier)
    if (fromPnpm !== undefined) return { url: pathToFileURL(fromPnpm).href, shortCircuit: true }
    throw error
  }
}

/**
 * `simple-icons` ships CommonJS, and the primitives bundle imports 32 of its
 * named exports — a shape Node's CJS lexer cannot see. Rewrite that one module
 * into ESM with every export it actually has.
 */
let simpleIconsSource
function simpleIconsModule() {
  if (simpleIconsSource !== undefined) return simpleIconsSource
  const cjs = resolveFromPnpm('simple-icons')
  if (cjs === undefined) return undefined
  const pkg = createRequire(cjs)('simple-icons')
  const names = Object.keys(pkg).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name))
  simpleIconsSource = [
    // `?cjs` keeps the original CommonJS module out of this rewrite.
    `import pkg from ${JSON.stringify(`${pathToFileURL(cjs).href}?cjs`)}`,
    'export default pkg',
    ...names.map((name) => `export const ${name} = pkg[${JSON.stringify(name)}]`),
  ].join('\n')
  return simpleIconsSource
}

/** @param {string} url @param {object} context @param {Function} next */
export async function load(url, context, next) {
  if (url.includes('/simple-icons/') && !url.includes('?cjs')) {
    const source = simpleIconsModule()
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
  }
  return next(url, context)
}
