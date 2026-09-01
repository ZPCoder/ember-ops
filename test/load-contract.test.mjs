import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getPath, normalizeEventEnvelopes, renderTemplate, validateLoadContract, validateRoomFixture } from "../load/pvp-contract.js";

function roomFixture(now = Date.now()) {
  return {
    schemaVersion: 2,
    protocolVersion: "1.0",
    targetId: "cloudflare",
    probeId: "cn-mainland-east",
    sourceSha: "a".repeat(40),
    runId: "run-1-cloudflare-cn-mainland-east",
    disconnectAt: new Date(now + 10_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    rooms: Array.from({ length: 250 }, (_value, roomIndex) => ({
      roomIndex,
      matchId: `match-${roomIndex}`,
      stateVersion: 1,
      cursor: 2,
      players: [0, 1].map((seat) => ({ seat, token: `token-${roomIndex}-${seat}-secret` })),
    })),
  };
}

const expected = {
  protocolVersion: "1.0", targetId: "cloudflare", probeId: "cn-mainland-east",
  sourceSha: "a".repeat(40), runId: "run-1-cloudflare-cn-mainland-east",
};

test("the contract requires canonical wire commands and true WebSocket reconnect", async () => {
  const contract = JSON.parse(await readFile(new URL("../load/fixtures/pvp-load-contract.json", import.meta.url), "utf8"));
  assert.deepEqual(validateLoadContract(contract), []);
  assert.equal(contract.schemaVersion, 2);
  assert.equal(contract.protocolVersion, "1.0");
  const rendered = renderTemplate(contract.endpoints.command.body, {
    protocolVersion: "1.0", requestId: "r", idempotencyKey: "i", expectedVersion: 7, seat: 1,
  });
  assert.deepEqual(rendered.command, { type: "concede", player: 1 });
  const invalid = structuredClone(contract);
  invalid.protocolVersion = "1.0.0";
  delete invalid.endpoints.command.body.command.player;
  assert.deepEqual(validateLoadContract(invalid), [
    "protocolVersion must be canonical major.minor",
    "command body must submit concede with command.player={seat}",
  ]);
});

test("v2 room fixture is exactly 250 rooms and 500 unique seated credentials", () => {
  const now = Date.now();
  const fixture = roomFixture(now);
  assert.deepEqual(validateRoomFixture(fixture, expected, now), []);
  const stale = structuredClone(fixture);
  stale.runId = "run-0-cloudflare-cn-mainland-east";
  assert.deepEqual(validateRoomFixture(stale, expected, now), ["fixture runId does not match the requested load gate"]);
  fixture.rooms[1].players[1].token = fixture.rooms[0].players[0].token;
  fixture.rooms[2].players[1].seat = 0;
  assert.deepEqual(validateRoomFixture(fixture, expected, now), [
    "room 1 has a missing or duplicate player token",
    "room 2 must contain seats 0 and 1 in order",
  ]);
});

test("event normalization requires match, cursor and state version", () => {
  const stream = { envelopeMode: "object", matchIdPath: "matchId", eventsPath: "events", cursorPath: "cursor", stateVersionPath: "stateVersion" };
  assert.equal(normalizeEventEnvelopes({ matchId: "m", events: [], cursor: 3, stateVersion: 4 }, stream)[0].matchId, "m");
  assert.throws(() => normalizeEventEnvelopes({ events: [] }, stream), /missing matchId/);
  assert.equal(getPath({ payload: { requestId: "r" } }, "payload.requestId"), "r");
});

test("k6 source configures 500 VUs and two real WebSocket sessions per client", async () => {
  const source = await readFile(new URL("../load/k6-pvp.js", import.meta.url), "utf8");
  assert.match(source, /executor: "per-vu-iterations"/);
  assert.match(source, /summaryTrendStats: \[[^\]]*"count"/);
  assert.match(source, /vus: 500/);
  assert.match(source, /ws\.connect/);
  assert.match(source, /pvp_ws_sessions/);
  assert.match(source, /count==1000/);
  assert.match(source, /openedAt >= disconnectAt/);
  assert.match(source, /acceptedCount >= 1 && settlementCount >= 1/);
  assert.match(source, /duplicateObservationMs/);
  assert.match(source, /pvp_websocket_open_timeouts/);
  assert.match(source, /pvp_state_propagation_samples/);
  assert.match(source, /validateRoomFixture/);
  assert.doesNotMatch(source, /shared-iterations|Connection": "close|pairFirst|pairSecond/);
});
