# @zpcoder/ember-ops

Build/deploy orchestration for the seven repositories. Ops owns no gameplay rule, player data, or analytics transformation. Only version tuples registered in `compatibility/versions.json` may reach integration or production.

The seven entries in each `active` and `rollback` section select exact package releases. The six external repositories are pinned twice: by `v<version>` and by an immutable 40-character `expectedCommits` SHA. Ops is deliberately not self-pinned in the matrix; it is the current protected workflow checkout (`GITHUB_SHA`, or local `HEAD`). Public wire and immutable gameplay-data versions are independent. Wire versions use canonical `major.minor` (`1.0`), while package and config versions use SemVer.

`scripts/checkout-compatible.mjs` receives the private token only in its workflow step. It checks the six detached tags against their registered SHAs and verifies that protocol, SDK, and config `0.1.0` packages exist in GitHub Packages with matching `gitHead`. No repository test inherits registry or GitHub credentials. `scripts/run-compatible.mjs` locally packs protocol/SDK/config, installs those tarballs offline into client and backend, runs the React fallback test/build, and compares a fixed React replay with the installed authoritative SDK digest. Guarded temporary clones are removed in script `finally` blocks and again by an `if: always()` cleanup step.

The secret-bearing release workflow runs only after a push to trusted `main`; tags and arbitrary manual refs cannot execute it. The public repository protects `main`: non-admin changes require an approved pull request, force pushes and branch deletion are disabled, and the owner retains an explicit emergency bypass. Pull requests use `.github/workflows/ops-ci.yml`, which has no secrets; `ops-unit-required` is the branch-protection check. GitHub-hosted preflights check repository readiness and all six environment-scoped endpoint secrets before any self-hosted job is scheduled. All Cocos and load workers must be ephemeral. The final release/promotion gate is `release-required`; it aggregates automated, editor, and six target/probe load artifacts from one exact workflow attempt rather than treating any component job as release approval by itself. GitHub partial job reruns are intentionally unsupported—use **Re-run all jobs** so every attempt produces a coherent evidence set.

The current backend does not yet expose the required real WebSocket Upgrade and v2 pre-provisioned-room facility. Keep `EMBER_PVP_WS_PREPROVISION_V2_ENABLED` unset or `false`; release preflight will fail quickly and no self-hosted runner will queue. Set it to `true` only after those backend capabilities exist and every load environment has HTTPS/WSS endpoints plus a protected pre-provisioning endpoint. Each matrix job calls that endpoint itself, validates the returned 250-room/500-identity fixture, stores it mode `0600` under `RUNNER_TEMP`, and deletes it even on failure.

```sh
npm ci --ignore-scripts
npm test
npm run check:k6
npm run check:matrix
```
