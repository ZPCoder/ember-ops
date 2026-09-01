import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { validateMatrix } from "../scripts/check-matrix.mjs";
import { decideHosting } from "../scripts/decide-hosting.mjs";

test("registered integration tuple is compatible", async () => {
  const matrix = JSON.parse(await readFile(new URL("../compatibility/versions.json", import.meta.url), "utf8"));
  assert.deepEqual(validateMatrix(matrix), []);
  assert.deepEqual(matrix.active, {
    protocol: "0.1.0",
    sdk: "0.1.0",
    config: "0.1.0",
    client: "0.1.0",
    backendAdmin: "0.1.0",
    ops: "0.1.0",
    data: "0.1.0",
  });
  assert.equal(matrix.contracts.active.protocolVersion, "1.0");
  assert.deepEqual(Object.keys(matrix.expectedCommits.active).sort(), ["backendAdmin", "client", "config", "data", "protocol", "sdk"]);
  assert.ok(Object.values(matrix.expectedCommits.active).every((sha) => /^[a-f0-9]{40}$/.test(sha)));
  assert.equal(matrix.contracts.active.configManifest.version, "1.0.0");
  assert.match(matrix.contracts.active.configManifest.sha256, /^[a-f0-9]{64}$/);
});

test("repository versions and public contract versions cannot be conflated", async () => {
  const matrix = JSON.parse(await readFile(new URL("../compatibility/versions.json", import.meta.url), "utf8"));
  matrix.active.config = "1.0.0+sha256.pending";
  matrix.contracts.active.protocolVersion = "not-a-version";
  matrix.contracts.active.configManifest.sha256 = "pending";
  assert.deepEqual(validateMatrix(matrix), [
    "active.config must be an exact SemVer package version",
    "contracts.active.protocolVersion must be a canonical major.minor wire version",
    "contracts.active.configManifest.sha256 must be a lowercase SHA-256 digest",
    "active protocol major is not supported",
  ]);
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

test("non-mainland evidence cannot satisfy the mainland hosting gate", () => {
  assert.equal(decideHosting({ probes: [
    { region: "US", statePropagationP95Ms: 100, reconnectP95Ms: 200, errorRate: 0, duplicateSettlements: 0, lostCommands: 0 },
  ] }), "container-mainland");
});
