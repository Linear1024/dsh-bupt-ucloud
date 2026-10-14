/**
 * Where the two test suites find the harness they verify against.
 *
 * These defaults are the machine this plugin was developed on: an
 * `npx @deepseek-ai/dsh` install (the host process a profile boots from) and a
 * monorepo checkout of the harness (used for React/jsdom builds and the
 * `ui-primitives` source). They are test-only facts — the plugin itself imports
 * nothing but Node builtins and the platform's own client module table.
 *
 * Override either with an environment variable when running the suites:
 *
 *   DSH_NPX_DIR=/path/to/npx-cache-dir   # the dir containing node_modules/@deepseek-ai/dsh
 *   DSH_REPO_DIR=/path/to/deepseek-harness
 *
 * The client suite additionally needs jsdom and React from the checkout's pnpm
 * store; `DSH_REPO_DIR` must point at a checkout that has been installed.
 */

/** `npx @deepseek-ai/dsh` install root. */
export const NPX_ROOT = process.env.DSH_NPX_DIR ?? '/home/linear/.npm/_npx/1e7f6d9597241db0'

/** DeepSeek Harness source checkout. */
export const REPO_ROOT = process.env.DSH_REPO_DIR ?? '/home/linear/deepseek-harness'

/** Deployed `@deepseek-ai/*` packages inside the npx install. */
export const DEPLOYED = `${NPX_ROOT}/node_modules/@deepseek-ai`

/** pnpm's content-addressed store inside the checkout. */
export const PNPM = `${REPO_ROOT}/node_modules/.pnpm`

/** The deployed browser build of the settings primitives. */
export const DEPLOYED_PRIMITIVES = `${DEPLOYED}/dsh-client-ui-primitives/lib/index.js`

/** The deployed primitives manifest, used as a resolution base. */
export const DEPLOYED_PRIMITIVES_MANIFEST = `${DEPLOYED}/dsh-client-ui-primitives/package.json`

/** The checkout's primitives manifest, used as a fallback resolution base. */
export const REPO_PRIMITIVES_MANIFEST = `${REPO_ROOT}/packages/client/ui-primitives/package.json`

/** React build the client suite renders with. */
export const REACT = `${PNPM}/react@18.3.1/node_modules/react`

/** React DOM build the client suite renders with. */
export const REACT_DOM = `${PNPM}/react-dom@18.3.1_react@18.3.1/node_modules/react-dom`

/** jsdom build the client suite runs in. */
export const JSDOM = `${PNPM}/jsdom@29.1.1_@noble+hashes@2.4.0/node_modules/jsdom`
