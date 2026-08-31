# 500 CCU gate

The k6 profile models 500 concurrent clients (about 250 rooms). Run it from Cloudflare and independently managed China-mainland probes. A release passes only when every mainland probe reports propagation p95 ≤ 800 ms, reconnect p95 ≤ 3 s, error rate < 0.5%, zero duplicate settlements, and zero lost accepted commands.

`scripts/decide-hosting.mjs` keeps Cloudflare only when every mainland result passes. Otherwise deploy the Node/PostgreSQL/Redis/WebSocket adapter without changing the protocol or rules.

The profile executes exactly 250 room iterations, each with two unique bearer identities from an untracked credentials file. It pairs both players, submits a `CommandEnvelope` containing `idempotencyKey` and `expectedVersion`, waits for the correlated `command-accepted` event at an advanced cursor/state version, replays the same idempotency key, reconnects from cursor zero, and requires exactly one terminal settlement.

API deployment shapes are intentionally not guessed. Set both required paths:

```sh
EMBER_API_URL=https://integration.example.invalid \
EMBER_PVP_LOAD_CONTRACT=load/fixtures/pvp-load-contract.json \
EMBER_LOAD_CREDENTIALS_FILE=/secure/ember-load-credentials.json \
k6 run load/k6-pvp.js
```

The checked-in contract fixture follows the public protocol and is validated by unit tests. An environment may supply a different endpoint/body adapter, but it must satisfy the same cursor, state-version, correlation, idempotency, and settlement fields. Missing or malformed adapters fail during k6 initialization.

The credentials file is never committed and has this shape with at least 500 unique entries:

```json
{
  "schemaVersion": 1,
  "players": [
    { "token": "secret-session-token", "deckId": "load-standard-001" }
  ]
}
```
