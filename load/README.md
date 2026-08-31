# 500 CCU gate

The k6 profile models 500 concurrent clients (about 250 rooms). Run it from Cloudflare and independently managed China-mainland probes. A release passes only when every mainland probe reports propagation p95 ≤ 800 ms, reconnect p95 ≤ 3 s, error rate < 0.5%, zero duplicate settlements, and zero lost accepted commands.

`scripts/decide-hosting.mjs` keeps Cloudflare only when every mainland result passes. Otherwise deploy the Node/PostgreSQL/Redis/WebSocket adapter without changing the protocol or rules.
