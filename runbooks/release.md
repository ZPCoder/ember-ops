# Release and rollback

1. Merge a tested version in each owning repository and create immutable `v<package version>` tags. The first compatibility run is expected only after all seven initial tags exist; the tag push also triggers the workflow.
2. Update `compatibility/versions.json`: `active`/`rollback` contain exact repository package versions, while `contracts` pins the independently versioned wire protocol and config manifest hash. Never deploy a combination absent from this file.
3. Require both workflow jobs: `automated-compatibility-no-editor` performs authenticated exact-tag checkouts and actual per-repository commands; `creator-editor-required` performs the licensed Cocos Creator 3.8.8 Web build on a configured self-hosted runner. A missing private-repository token, tag, editor runner, or editor path is a release failure.
4. Run the 250-room/500-client k6 profile from Cloudflare and mainland probes with environment-specific API and credential adapters. Retain its threshold summary with the SHA evidence.
5. Promote internal slice → dual-client parity → load gate → 4399 sandbox → canary → full traffic.
6. Roll back by atomically applying the `rollback` tuple. Do not independently downgrade config or protocol.

Secrets are referenced by environment-specific secret-manager identifiers. This repository must not contain credentials, 4399 tickets, private keys, or plaintext database passwords.
