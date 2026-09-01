# 500 CCU gate

The k6 profile uses 500 real VUs and 250 pre-provisioned two-seat rooms. Each VU owns one unique bearer identity, establishes a real WebSocket, holds it until a shared disconnect instant, closes it, and then establishes a second WebSocket from its last cursor. It is not a room-creation test and has no HTTP “reconnect” substitute.

`scripts/decide-hosting.mjs` keeps Cloudflare only when every mainland result passes. Otherwise deploy the Node/PostgreSQL/Redis/WebSocket adapter without changing the protocol or rules.

The profile executes exactly 500 per-VU iterations. One deterministic actor per room submits canonical protocol `1.0` `concede` with `command.player`, `Idempotency-Key`, and `expectedVersion`; both seats must recover the correlated event and exactly one settlement after reconnect. Evidence must prove 500 clients, 250 rooms, 1,000 WebSocket sessions, 250 accepted commands, 500 observed commands/settlements, no early initial closes, and all thresholds.

API deployment shapes are intentionally not guessed. Set both required paths:

```sh
EMBER_API_URL=https://integration.example.invalid \
EMBER_WS_URL=wss://integration.example.invalid \
EMBER_PVP_LOAD_CONTRACT=load/fixtures/pvp-load-contract.json \
EMBER_LOAD_ROOM_FIXTURE=/runner-temp/preprovisioned-rooms-v2.json \
EMBER_LOAD_TARGET=cloudflare EMBER_LOAD_PROBE_ID=cn-mainland-east \
EMBER_LOAD_RUN_ID=unique-run EMBER_SOURCE_SHA=<40-character-sha> \
EMBER_K6_EVIDENCE_PATH=evidence/k6-cloudflare-cn-mainland-east.json \
k6 run load/k6-pvp.js
```

The checked-in contract fixture follows the public protocol and is validated by unit tests. An environment may supply a different endpoint/body adapter, but it must satisfy the same cursor, state-version, correlation, idempotency, and settlement fields. Missing or malformed adapters fail during k6 initialization.

The room fixture is never committed. It expires, is bound to a target/probe/source SHA, supplies a common future disconnect instant, and contains exactly 250 entries of this shape:

```json
{
  "schemaVersion": 2,
  "protocolVersion": "1.0",
  "targetId": "cloudflare",
  "probeId": "cn-mainland-east",
  "sourceSha": "<40-character-sha>",
  "disconnectAt": "future ISO timestamp",
  "expiresAt": "later ISO timestamp",
  "rooms": [{
    "roomIndex": 0,
    "matchId": "preprovisioned-match",
    "stateVersion": 1,
    "cursor": 2,
    "players": [{ "seat": 0, "token": "secret-a" }, { "seat": 1, "token": "secret-b" }]
  }]
}
```

Every probe uses a fresh fixture under `RUNNER_TEMP`; fixtures are deleted even on failure and never uploaded. The workflow tests both Cloudflare and the mainland container from the Cloudflare-egress, mainland-east, and mainland-south runners. Cloudflare is retained only if all three pass; otherwise every container probe must pass or `release-required` fails.
