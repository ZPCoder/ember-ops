import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXACT_COUNTS = Object.freeze({
  iterations: 500,
  dropped_iterations: 0,
  pvp_clients_started: 500,
  pvp_rooms_seen: 250,
  pvp_ws_sessions: 1000,
  pvp_initial_ws_opened: 500,
  pvp_initial_authoritative: 500,
  pvp_initial_ws_closed: 500,
  pvp_reconnect_ws_opened: 500,
  pvp_reconnect_caught_up: 500,
  pvp_state_propagation_samples: 500,
  pvp_commands_accepted: 250,
  pvp_commands_observed: 500,
  pvp_settlements_observed: 500,
  pvp_lost_accepted_commands: 0,
  pvp_duplicate_command_events: 0,
  pvp_duplicate_settlement: 0,
  pvp_missing_settlement: 0,
  pvp_idempotency_violations: 0,
  pvp_websocket_failures: 0,
  pvp_early_initial_closes: 0,
  pvp_late_initial_opens: 0,
  pvp_websocket_open_timeouts: 0,
});

export function validateK6Summary(summary, expected) {
  const errors = [];
  if (summary?.schemaVersion !== 1 || summary?.status !== "passed") errors.push("summary status is not passed");
  for (const field of ["targetId", "probeId", "sourceSha", "runId"]) {
    if (summary?.[field] !== expected?.[field]) errors.push(`${field} does not match the required gate`);
  }
  if (!Number.isFinite(Date.parse(summary?.generatedAt ?? ""))) errors.push("generatedAt is missing or invalid");
  if (summary?.protocolVersion !== "1.0" || summary?.configuredVus !== 500 || summary?.configuredRooms !== 250) {
    errors.push("summary does not describe canonical 1.0 / 500 VU / 250 room load");
  }
  if (!Array.isArray(summary?.thresholdFailures) || summary.thresholdFailures.length !== 0) errors.push("summary has threshold failures");
  for (const [name, expectedCount] of Object.entries(EXACT_COUNTS)) {
    const metric = summary?.metrics?.[name];
    if (!metric || metric.values?.count !== expectedCount) errors.push(`${name} count must equal ${expectedCount}`);
    const thresholds = metric?.thresholds;
    if (!thresholds || Object.values(thresholds).some((threshold) => threshold?.ok !== true)) errors.push(`${name} threshold is missing or failed`);
  }
  for (const name of ["vus_max", "pvp_state_propagation_ms", "pvp_reconnect_ms", "pvp_error_rate", "checks", "http_req_failed"]) {
    const metric = summary?.metrics?.[name];
    if (!metric || Object.values(metric.values ?? {}).some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      errors.push(`${name} has missing or non-finite values`);
    }
    if (!metric?.thresholds || Object.values(metric.thresholds).some((threshold) => threshold?.ok !== true)) {
      errors.push(`${name} threshold is missing or failed`);
    }
  }
  if (summary?.metrics?.pvp_state_propagation_ms?.values?.count !== 500) {
    errors.push("pvp_state_propagation_ms must contain exactly 500 samples");
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [path, targetId, probeId, sourceSha, runId] = process.argv.slice(2);
  if (!path || !targetId || !probeId || !sourceSha || !runId) {
    throw new Error("usage: verify-k6-summary.mjs <path> <target> <probe> <sha> <run-id>");
  }
  const summary = JSON.parse(await readFile(path, "utf8"));
  const errors = validateK6Summary(summary, { targetId, probeId, sourceSha, runId });
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`verified k6 evidence: ${targetId}/${probeId} @ ${sourceSha}`);
  }
}
