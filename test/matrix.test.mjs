import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { validateMatrix } from "../scripts/check-matrix.mjs";
import { decideHosting } from "../scripts/decide-hosting.mjs";

test("registered integration tuple is compatible", async () => {
  const matrix = JSON.parse(await readFile(new URL("../compatibility/versions.json", import.meta.url), "utf8"));
  assert.deepEqual(validateMatrix(matrix), []);
});

test("any failed mainland probe selects the container adapter", () => {
  assert.equal(decideHosting({ probes: [
    { region: "CN", statePropagationP95Ms: 700, reconnectP95Ms: 2500, errorRate: 0.001, duplicateSettlements: 0, lostCommands: 0 },
    { region: "CN", statePropagationP95Ms: 801, reconnectP95Ms: 2500, errorRate: 0.001, duplicateSettlements: 0, lostCommands: 0 },
  ] }), "container-mainland");
});

test("all mainland probes must pass to retain Cloudflare", () => {
  assert.equal(decideHosting({ probes: [
    { region: "CN", statePropagationP95Ms: 700, reconnectP95Ms: 2500, errorRate: 0.001, duplicateSettlements: 0, lostCommands: 0 },
  ] }), "cloudflare");
});
