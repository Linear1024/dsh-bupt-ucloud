# tests/

Two self-contained suites (no network, no harness install):

```bash
node tests/host.test.mjs     # 51 checks — host half
node tests/client.test.mjs   # 16 checks — client half
```

`paths.mjs` names the two installations the suites verify against — an
`npx @deepseek-ai/dsh` install and a harness source checkout — and defaults to
the machine this plugin was written on. Point the suites elsewhere with
`DSH_NPX_DIR` / `DSH_REPO_DIR`; the client suite also needs that checkout's pnpm
store (React, jsdom).

`loader-hooks.mjs` exists only for the client suite: it resolves the deployed
`@deepseek-ai/dsh-client-ui-primitives` browser build (CSS modules → stub,
React/React DOM/clsx → the builds the test renders with, `simple-icons` CJS →
ESM) so the card is mounted against the real settings primitives. The plugin
itself has no such dependency.

## Integration check against a real harness

The suites stub the Host. To verify the plugin against a **real** loader without
touching the user's profile, compose a scratch profile under a scratch
`DSH_HOME` (all paths below are relative to the workspace root):

```bash
# 1. A writable copy of the web profile that shares its package store.
mkdir -p .dsh-test/profiles/web
ln -s ~/.dsh/profiles/node_modules .dsh-test/profiles/node_modules
mkdir .dsh-test/profiles/web/node_modules
for e in ~/.dsh/profiles/web/node_modules/*; do ln -s "$e" .dsh-test/profiles/web/node_modules/; done
ln -s "$PWD/dsh-bupt-ucloud" .dsh-test/profiles/web/node_modules/dsh-bupt-ucloud
cp ~/.dsh/profiles/web/{package.json,cordis.patch.yml,pnpm-workspace.yaml} .dsh-test/profiles/web/
# add "dsh-bupt-ucloud": "link:$PWD/dsh-bupt-ucloud" to dependencies and "dsh-bupt-ucloud"
# to dsh.profile.bundles in .dsh-test/profiles/web/package.json

# 2. The bundle's own cordis.patch.yml is composed into the tree.
DSH_HOME=$PWD/.dsh-test <dsh> --profile web --dump-config | grep -A 2 'dsh-bupt-ucloud'

# 3. Boot it on another port and probe the surfaces.
DSH_HOME=$PWD/.dsh-test <dsh> --profile web --port 3099 --no-open
```

What was confirmed this way against `dsh` 0.2.0-rc.2:

| Surface | Probe | Result |
|---|---|---|
| Bundle + patch compose | `--dump-config` | `- id: ucloud` / `name: dsh-bupt-ucloud` in the tree |
| Host module mounts | any request | the test plugin's `apply` ran, no import/Config error |
| Client bundle is served | boot payload `__DSH_BOOT__` | `dsh-bupt-ucloud/client.js` is a graph entry |
| Settings namespace | `POST /api/settings/describe` | `{"ns":"ucloud", "autoGenerate":true, "schema":{…"dict":{"username":…}}, "applies":"live"}` |
| Settings write | `POST /api/settings/mutate` | `{ns:"ucloud", ops:[{op:"set",path:["username"],value:"20210001"}]}` → `value.username = "20210001"`, revision 1 |
| Credentials seam | `POST /api/credentials/describe` | `{ok:true, value:{UCLOUD_PASSWORD:{configured:false,writable:true}, …}}` |
| Plugin route + fence | `POST /dsh-bupt-ucloud/verify` | after the write: `400 missing-password` (the 学号 is live) |

The RPC envelope is `POST /api/<namespace>/<method>` with
`{"type":"client-request","rpcId":"<uuid>","method":"<namespace>/<method>","payload":{"args":{…}}}`,
authenticated with the browser session cookie the `?token=` bootstrap sets.

`profile-overlay.yml` inserts the same row by absolute path, for
`dsh --dump-config --patch tests/profile-overlay.yml` on a writable profile.
