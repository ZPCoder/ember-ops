# @zpcoder/ember-ops

Build/deploy orchestration for the seven repositories. Ops owns no gameplay rule, player data, or analytics transformation. Only version tuples registered in `compatibility/versions.json` may reach integration or production.

The seven entries in each `active` and `rollback` section select exact repository package releases (resolved as `v<version>` Git tags), including the Ops revision that executes the deployment. Public wire and immutable gameplay-data versions are independent: the corresponding `contracts.active` and `contracts.rollback` entries record the protocol line and pin the config version plus SHA-256 digest.

`scripts/checkout-compatible.mjs` authenticates with a required `GH_TOKEN`, binds every private HTTPS clone and tag fetch to `gh auth git-credential`, checks out a detached exact tag, verifies the package version, and records the resolved commit SHA. `scripts/run-compatible.mjs` then runs locked installs and the actual protocol, SDK, config, client, backend, Ops, and data commands. It fails on the first rejected command or generated-source drift and deletes the isolated checkout after recording evidence.

The ordinary Ubuntu job deliberately does not claim a Cocos build. The separately required `creator-editor-required` job targets a self-hosted `cocos-creator-3.8.8` runner, requires an absolute `COCOS_CREATOR_CLI`, verifies editor version 3.8.8, and produces a real Web Desktop build. Configure branch protection/release rules to require both jobs.

```sh
npm ci --ignore-scripts
npm test
npm run check:k6
npm run check:matrix
```
