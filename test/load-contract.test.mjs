import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  getPath,
  normalizeEventEnvelopes,
  renderTemplate,
  validateLoadContract,
} from "../load/pvp-contract.js";

test("the environment adapter fixture defines a fail-closed 250-room contract", async () => {
  const contract = JSON.parse(await readFile(new URL("../load/fixtures/pvp-load-contract.json", import.meta.url), "utf8"));
  assert.deepEqual(validateLoadContract(contract), []);
  assert.equal(contract.roomCount, 250);
  assert.equal(contract.logicalClients, 500);
  const rendered = renderTemplate(contract.endpoints.command.body, {
    protocolVersion: "1.0.0",
    requestId: "request-1",
    idempotencyKey: "idempotency-1",
    expectedVersion: 7,
  });
  assert.equal(rendered.expectedVersion, 7);
  assert.equal(rendered.command.type, "concede");
  assert.throws(() => renderTemplate("/matches/{missing}", {}), /missing template value/);
});

test("event normalization requires authoritative cursor and state version", () => {
  const stream = { envelopeMode: "object", eventsPath: "events", cursorPath: "cursor", stateVersionPath: "stateVersion" };
  assert.deepEqual(normalizeEventEnvelopes({ events: [{ type: "command-accepted" }], cursor: 3, stateVersion: 4 }, stream), [{
    envelope: { events: [{ type: "command-accepted" }], cursor: 3, stateVersion: 4 },
    events: [{ type: "command-accepted" }],
    cursor: 3,
    stateVersion: 4,
  }]);
  assert.throws(() => normalizeEventEnvelopes({ events: [] }, stream), /missing events, cursor, or stateVersion/);
  assert.equal(getPath({ payload: { requestId: "request-1" } }, "payload.requestId"), "request-1");
});

test("k6 gate measures accepted-command loss, idempotency, settlement, pairing, and reconnect", async () => {
  const source = await readFile(new URL("../load/k6-pvp.js", import.meta.url), "utf8");
  for (const required of [
    "pvp_lost_accepted_commands",
    "pvp_duplicate_command_events",
    "pvp_duplicate_settlement",
    "pvp_missing_settlement",
    "pvp_idempotency_violations",
    "pvp_state_propagation_ms",
    "pvp_reconnect_ms",
    "pvp_rooms_paired",
    "expectedVersion",
    "idempotencyKey",
  ]) {
    assert.match(source, new RegExp(required));
  }
  assert.match(source, /EMBER_PVP_LOAD_CONTRACT is required/);
  assert.match(source, /EMBER_LOAD_CREDENTIALS_FILE is required/);
  assert.doesNotMatch(source, /duplicateSettlement"\) === true/);
});
