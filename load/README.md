# 500 CCU gate

The k6 profile uses 500 real VUs and 250 pre-provisioned two-seat rooms. Each VU owns one unique bearer identity, must open a real WebSocket before a shared disconnect instant, holds it through that instant, closes it, and then establishes a second WebSocket from its last cursor. Those overlapping intervals prove all 500 initial sockets were concurrently authenticated. It is not a room-creation test and has no HTTP “reconnect” substitute.

`scripts/decide-hosting.mjs` keeps Cloudflare only when every mainland result passes. Otherwise deploy the Node/PostgreSQL/Redis/WebSocket adapter without changing the protocol or rules.

The profile executes exactly 500 per-VU iterations. One deterministic actor per room submits canonical protocol `1.0` `concede` with `command.player`, `Idempotency-Key`, and `expectedVersion`; both seats must recover the correlated event and exactly one settlement after reconnect. Reconnect latency stops only after both correlated acceptance and the unique terminal settlement arrive, then the socket remains open for a short duplicate-observation window. Evidence must prove 500 clients, 250 rooms, 1,000 WebSocket sessions, 250 accepted commands, 500 observed commands/settlements, exactly 500 state-propagation samples (both seats), no early closes, late opens, handshake timeouts, lost commands, or duplicate settlements, and all thresholds.

The workflow first calls a protected HTTPS pre-provisioning endpoint with an environment secret. That endpoint must atomically mint the requested rooms and return the v2 fixture; the workflow never accepts a static fixture path. For a manual run, provision the fixture first and then set both runtime endpoints:

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
  "runId": "<workflow-run-attempt-target-probe>",
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

Every probe uses a fresh run-attempt-bound fixture under `RUNNER_TEMP`; fixtures are deleted even on failure and never uploaded. The workflow serializes the six 500-VU probes so a target is never accidentally subjected to a combined 1,500-CCU test. It tests both Cloudflare and the mainland container from the Cloudflare-egress, mainland-east, and mainland-south runners. Cloudflare is retained only if all three pass; otherwise every container probe must pass or `release-required` fails.
