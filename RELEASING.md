# Releasing `@arsel.sa/web-sdk`

A release is a git tag. Pushing `vX.Y.Z` runs `.github/workflows/release.yml`: typecheck, tests,
build, `npm publish`, and a GitHub release with the matching CHANGELOG section as notes. No tag,
no publish.

## Authentication (one-time setup)

The workflow publishes with **npm trusted publishing** — GitHub mints a short-lived OIDC token per
run. There is no `NPM_TOKEN` secret to rotate, leak or expire.

1. **npm scope.** The `arsel.sa` organization on npmjs.com owns the `@arsel.sa/*` scope. (`arsel`
   was already taken; `@arsel.sa` also mirrors the Android `sa.arsel` namespace.)
2. **Trusted publisher.** npmjs.com → package settings for `@arsel.sa/web-sdk` → Trusted Publisher
   → GitHub Actions:

   | Field | Value |
   | --- | --- |
   | Organization | `BasicsEngage` |
   | Repository | `arsel-web-sdk` |
   | Workflow filename | `release.yml` |
   | Environment | `release` |
   | Allowed actions | `npm publish` |

   Fill in **Environment** — left blank, any workflow in the repo could publish, which defeats the
   `release` approval gate. A trusted publisher can only be attached to a package that already
   exists on the registry ([npm/cli#8544](https://github.com/npm/cli/issues/8544)), so the very
   first publish of a *new* package still needs a token (see the fallback below).

The workflow reinstalls npm (`npm install -g npm@latest`) before publishing: trusted publishing
needs npm ≥ 11.5.1 / Node ≥ 22.14.0, and `setup-node` with `node-version: 22` ships npm 10.9.x,
which fails with a misleading `404` / `ENEEDAUTH` rather than a version error
([npm/cli#9088](https://github.com/npm/cli/issues/9088)). Don't drop that step.

The `setup-node` step deliberately has **no `registry-url`**. With it, setup-node writes an
`.npmrc` containing `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` and sets
`NODE_AUTH_TOKEN` to its own `XXXXX-XXXXX-XXXXX-XXXXX` placeholder when no token is supplied. npm
then sends that bogus credential on every request and never falls through to OIDC — and reports the
rejection as `404 Not Found - PUT https://registry.npmjs.org/@arsel.sa%2fweb-sdk`, which reads like
a missing package rather than an auth failure. The tell is `npm warn Unknown user config
"always-auth"` in the log: that warning only appears when setup-node's `.npmrc` is in play. Adding
`registry-url` back breaks publishing.

Provenance attestations are generated automatically under OIDC — no `--provenance` flag — and
require the GitHub repo to be **public** at publish time. Confirm after a release:

```bash
npm view @arsel.sa/web-sdk --json | jq '.dist.attestations'
```

### Token fallback

Only if trusted publishing is unavailable (a brand-new package, or publishing from outside this
workflow). In npm: Access Tokens → Generate New Token → **Granular**, permission *Read and write*
scoped to the package or the `arsel.sa` org. Not a classic token — and **enable "Bypass 2FA"**, or
the publish fails with `403 ... Two-factor authentication or granular access token with bypass 2fa
enabled is required`. Verify before wiring it up:

```bash
curl -s -H "Authorization: Bearer $TOKEN" https://registry.npmjs.org/-/npm/v1/tokens
```

The token's entry must show `"bypass_2fa": true`. Mind the `expiry` too — an expiring token breaks
CI silently months later. Using one means restoring the `NODE_AUTH_TOKEN` env block on the publish
step and adding `--provenance` back.

## Per release

1. Retitle `## [Unreleased]` in `CHANGELOG.md` to `## [X.Y.Z] — YYYY-MM-DD` (a fresh
   `## [Unreleased]` heading goes above it). The workflow fails if the tagged version has no
   section.
2. Bump the version in **all three** places, or the `X-Arsel-SDK` header reports a stale build:
   `package.json`, `src/version.ts` (`SDK_VERSION`) and `sw/arsel-sw.js` (`SDK_VERSION`). The
   service worker is served uncompiled and cannot import from the build, so its copy is duplicated
   on purpose. Only the `package.json` value is enforced by the workflow.
3. Commit, then `git tag vX.Y.Z && git push origin main vX.Y.Z`.

The tag must equal the `package.json` version (the workflow enforces it).

## CDN

No separate CDN step: once published, unpkg and jsDelivr serve the UMD build automatically (the
`unpkg`/`jsdelivr` fields in `package.json` point at it), including `sw/arsel-sw.js` for
integrators who prefer `importScripts` over copying the file.
