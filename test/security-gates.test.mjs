import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { aggregateReleaseEvidence } from "../scripts/aggregate-release-evidence.mjs";
import { cleanupCompatibleWorkspaces } from "../scripts/cleanup-compatible.mjs";
import { validateK6Summary } from "../scripts/verify-k6-summary.mjs";

const counts = {
  iterations: 500, dropped_iterations: 0, pvp_clients_started: 500, pvp_rooms_seen: 250,
  pvp_ws_sessions: 1000, pvp_initial_ws_opened: 500, pvp_initial_authoritative: 500,
  pvp_initial_ws_closed: 500, pvp_reconnect_ws_opened: 500, pvp_reconnect_caught_up: 500,
  pvp_state_propagation_samples: 500,
  pvp_commands_accepted: 250, pvp_commands_observed: 500, pvp_settlements_observed: 500,
  pvp_lost_accepted_commands: 0, pvp_duplicate_command_events: 0, pvp_duplicate_settlement: 0,
  pvp_missing_settlement: 0, pvp_idempotency_violations: 0, pvp_websocket_failures: 0,
  pvp_early_initial_closes: 0, pvp_late_initial_opens: 0, pvp_websocket_open_timeouts: 0,
};

function passingSummary(targetId = "cloudflare", probeId = "cn-mainland-east", sourceSha = "a".repeat(40)) {
  const threshold = { thresholds: { required: { ok: true } } };
  return {
    schemaVersion: 1, status: "passed", targetId, probeId,
    sourceSha, protocolVersion: "1.0", configuredVus: 500, configuredRooms: 250,
    runId: `run-${targetId}-${probeId}`, generatedAt: new Date().toISOString(),
    thresholdFailures: [],
    metrics: {
      ...Object.fromEntries(Object.entries(counts).map(([name, count]) => [name, { values: { count }, ...threshold }])),
      vus_max: { values: { value: 500 }, ...threshold },
      pvp_state_propagation_ms: { values: { "p(95)": 700, count: 500 }, ...threshold },
      pvp_reconnect_ms: { values: { "p(95)": 2500 }, ...threshold },
      pvp_error_rate: { values: { rate: 0 }, ...threshold },
      checks: { values: { rate: 1 }, ...threshold },
      http_req_failed: { values: { rate: 0 }, ...threshold },
    },
  };
}

async function writeReleaseEvidence(root, passingTargets, sourceSha = "a".repeat(40)) {
  const clientSha = "b".repeat(40);
  await writeFile(join(root, "gates.json"), JSON.stringify({
    status: "passed-automated-boundaries",
    repositories: { ops: { sha: sourceSha }, client: { sha: clientSha } },
  }));
  await writeFile(join(root, "cocos-editor.json"), JSON.stringify({
    status: "passed-editor-boundary", client: { sha: clientSha },
  }));
  const probes = ["cloudflare-egress", "cn-mainland-east", "cn-mainland-south"];
  for (const targetId of ["cloudflare", "mainland-container"]) {
    for (const probeId of probes) {
      const summary = passingSummary(targetId, probeId, sourceSha);
      if (!passingTargets.includes(targetId)) summary.metrics.pvp_clients_started.values.count = 499;
      await writeFile(join(root, `k6-${targetId}-${probeId}.json`), JSON.stringify(summary));
    }
  }
}

test("summary verifier rejects a 499-client fake green", () => {
  const summary = passingSummary();
  const expected = {
    targetId: "cloudflare", probeId: "cn-mainland-east", sourceSha: "a".repeat(40),
    runId: "run-cloudflare-cn-mainland-east",
  };
  assert.deepEqual(validateK6Summary(summary, expected), []);
  summary.metrics.pvp_clients_started.values.count = 499;
  assert.ok(validateK6Summary(summary, expected)
    .includes("pvp_clients_started count must equal 500"));
});

test("release aggregation prefers Cloudflare only after all three probes pass", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ember-release-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeReleaseEvidence(root, ["cloudflare", "mainland-container"]);
  const evidence = await aggregateReleaseEvidence(root, "a".repeat(40), "run");
  assert.equal(evidence.selectedHosting, "cloudflare");
  assert.deepEqual(evidence.targetPasses, { cloudflare: true, "mainland-container": true });
});

test("release aggregation rejects ambiguous duplicate artifact basenames", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ember-release-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeReleaseEvidence(root, ["cloudflare"]);
  const duplicate = join(root, "stale-attempt");
  await mkdir(duplicate);
  await writeFile(join(duplicate, "k6-cloudflare-cn-mainland-east.json"), "{}\n");
  await assert.rejects(
    aggregateReleaseEvidence(root, "a".repeat(40), "run"),
    /duplicate evidence basename: k6-cloudflare-cn-mainland-east\.json/,
  );
});

test("release aggregation falls back only when every mainland probe passes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ember-release-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeReleaseEvidence(root, ["mainland-container"]);
  const evidence = await aggregateReleaseEvidence(root, "a".repeat(40), "run");
  assert.equal(evidence.selectedHosting, "mainland-container");
  assert.deepEqual(evidence.targetPasses, { cloudflare: false, "mainland-container": true });

  const failedProbe = join(root, "k6-mainland-container-cn-mainland-south.json");
  const summary = JSON.parse(await readFile(failedProbe, "utf8"));
  summary.metrics.pvp_clients_started.values.count = 499;
  await writeFile(failedProbe, JSON.stringify(summary));
  await assert.rejects(
    aggregateReleaseEvidence(root, "a".repeat(40), "run"),
    /neither Cloudflare nor the mainland container passed every required probe/,
  );
});

test("cleanup removes only marked compatibility workspaces", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "ember-cleanup-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const guarded = join(base, "ember-compat-active-valid");
  const unguarded = join(base, "ember-compat-active-keep");
  await mkdir(guarded);
  await mkdir(unguarded);
  await writeFile(join(guarded, ".ember-compat-workspace.json"), JSON.stringify({ schemaVersion: 1, section: "active", createdBy: "ember-ops/checkout-compatible" }));
  await writeFile(join(unguarded, ".ember-compat-workspace.json"), JSON.stringify({ schemaVersion: 1, section: "active", createdBy: "someone-else" }));
  assert.deepEqual(await cleanupCompatibleWorkspaces(base), [guarded]);
  assert.equal((await readFile(join(unguarded, ".ember-compat-workspace.json"), "utf8")).includes("someone-else"), true);
});
