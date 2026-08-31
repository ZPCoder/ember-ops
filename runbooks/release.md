# Release and rollback

1. Merge a tested version in each owning repository and publish GitHub Releases/Packages.
2. Update `compatibility/versions.json`; never deploy a combination absent from this file.
3. Run protocol generation, fixed-seed replay parity, Cocos static/build gate, React build, canonical empty/legacy DB migrations, end-to-end PVP, and 500 CCU.
4. Promote internal slice → dual-client parity → load gate → 4399 sandbox → canary → full traffic.
5. Roll back by atomically applying the `rollback` tuple. Do not independently downgrade config or protocol.

Secrets are referenced by environment-specific secret-manager identifiers. This repository must not contain credentials, 4399 tickets, private keys, or plaintext database passwords.
