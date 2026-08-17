# Releasing `@arsel/web-sdk`

A release is a git tag. Pushing `vX.Y.Z` runs `.github/workflows/release.yml`: typecheck, tests,
build, `npm publish`, and a GitHub release with the matching CHANGELOG section as notes. No tag,
no publish.

## One-time setup (blocks the first publish)

1. **npm scope.** Create the `arsel` organization on npmjs.com (Add Organization → `arsel`) — it
   owns the `@arsel/*` scope.
2. **Token.** In npm: Access Tokens → Generate New Token → **Granular**, permission
   *Read and write* scoped to the `@arsel/web-sdk` package (or the `arsel` org before the package
   exists). Not a classic token.
3. **Secret.** In this GitHub repo: Settings → Secrets and variables → Actions → new secret
   `NPM_TOKEN` with that value.

Until the secret exists the workflow fails at its first step with a pointer here.

`npm publish` runs with `--provenance`, which requires the GitHub repo to be **public** at publish
time. Publishing while the repo is private: remove the flag for that release.

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
