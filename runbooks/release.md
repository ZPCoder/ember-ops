# Release and rollback

1. Merge and publish in dependency order. Protocol, SDK, and config must each have an immutable `v0.1.0` tag and matching GitHub Package (including matching `gitHead`); client, backend-admin, and data need immutable tags. Only after all six tags and all three packages exist should the Ops compatibility workflow be manually dispatched. Ops uses that workflow's current protected SHA and does not self-reference a matrix SHA.
2. Update `compatibility/versions.json`: `active`/`rollback` contain exact repository package versions, while `contracts` pins the independently versioned wire protocol and config manifest hash. Never deploy a combination absent from this file.
3. Set readiness variables only when their resources exist. In particular, `EMBER_PVP_WS_PREPROVISION_V2_ENABLED=true` asserts that the backend has a real WSS Upgrade endpoint and can mint fresh two-seat v2 fixtures; it must remain false today. The GitHub-hosted preflight fails before scheduling any unavailable self-hosted worker.
4. Require only the final `release-required` check for release promotion (and `ops-unit-required` for pull requests). It requires automated compatibility, the licensed Cocos 3.8.8 build, and complete Cloudflare/container load evidence. Self-hosted editor and load runners must be ephemeral.
5. Run each 500-VU/250-room target from all three explicit probes. Cloudflare passes only if all its probes pass; otherwise every mainland-container probe must pass. Missing, stale, wrong-SHA, malformed, or threshold-failed evidence blocks release.
6. Promote internal slice → dual-client parity → load gate → 4399 sandbox → canary → full traffic.
7. Roll back by atomically applying the `rollback` tuple. Do not independently downgrade config or protocol.

Secrets are referenced by environment-specific secret-manager identifiers. This repository must not contain credentials, 4399 tickets, private keys, or plaintext database passwords.
