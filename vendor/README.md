# vendor/

`schemastery.js` is a single-file ESM bundle of
`@deepseek-ai/schemastery@3.18.4` (MIT), built with:

```bash
NODE_PATH=<dsh checkout>/node_modules \
  <dsh checkout>/node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/bin/esbuild \
  --bundle entry.js --format=esm --platform=node --target=node18 \
  --outfile=vendor/schemastery.js --legal-comments=inline

# entry.js
export { default } from '@deepseek-ai/schemastery'
```

The Host half exports a schemastery `Config` so the Plugins page can edit
`username` live. A third-party bundle cannot import `@deepseek-ai/*` directly:
the plugin directory is linked into the profile, and Node resolves imports from
the link's real path — outside the profile's `node_modules`. Bundling the one
schema library it needs keeps the plugin dependency-free, and the schema is
still read across the seam: cordis validates it through `~standard`, and
`dsh-settings` rehydrates it from `toJSON()`, both of which the shipped loader
already does with its own copy.

Regenerate it only when bumping the schema library version; the vendored build
is test-covered (`tests/host.test.mjs` loads it through the real cordis
`resolveConfig`).
