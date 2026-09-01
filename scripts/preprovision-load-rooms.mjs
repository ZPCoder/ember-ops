import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRoomFixture } from "../load/pvp-contract.js";

const PROTOCOL_VERSION = "1.0";
const TARGETS = new Set(["cloudflare", "mainland-container"]);
const PROBES = new Set(["cloudflare-egress", "cn-mainland-east", "cn-mainland-south"]);

function requiredString(name, value, pattern) {
  if (typeof value !== "string" || !value.trim() || (pattern && !pattern.test(value))) {
    throw new Error(`${name} is invalid`);
  }
  return value.trim();
}

export async function preprovisionLoadRooms(options) {
  const {
    endpoint,
    token,
    targetId,
    probeId,
    sourceSha,
    runId,
    outputPath,
    fetchImpl = globalThis.fetch,
    now = Date.now(),
  } = options;
  const endpointUrl = new URL(requiredString("endpoint", endpoint));
  if (endpointUrl.protocol !== "https:") throw new Error("endpoint must use HTTPS");
  const secret = requiredString("token", token);
  if (!TARGETS.has(targetId)) throw new Error("targetId is invalid");
  if (!PROBES.has(probeId)) throw new Error("probeId is invalid");
  requiredString("sourceSha", sourceSha, /^[a-f0-9]{40}$/);
  requiredString("runId", runId, /^[A-Za-z0-9._-]+$/);
  requiredString("outputPath", outputPath);
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is unavailable");

  const response = await fetchImpl(endpointUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      "idempotency-key": `load-${runId}`,
    },
    body: JSON.stringify({
      schemaVersion: 2,
      protocolVersion: PROTOCOL_VERSION,
      targetId,
      probeId,
      sourceSha,
      runId,
      roomCount: 250,
      logicalClients: 500,
      disconnectAfterSeconds: 60,
      expiresAfterSeconds: 900,
    }),
  });
  if (!response?.ok) {
    throw new Error(`room pre-provisioning failed with HTTP ${response?.status ?? "unknown"}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("room pre-provisioning response was not JSON");
  }
  const fixture = payload?.fixture ?? payload;
  const errors = validateRoomFixture(fixture, {
    protocolVersion: PROTOCOL_VERSION,
    targetId,
    probeId,
    sourceSha,
    runId,
  }, now);
  if (errors.length > 0) throw new Error(`invalid room pre-provisioning response: ${errors.join("; ")}`);

  const destination = resolve(outputPath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(fixture)}\n`, { mode: 0o600, flag: "wx" });
  return {
    outputPath: destination,
    roomCount: fixture.rooms.length,
    logicalClients: fixture.rooms.reduce((total, room) => total + room.players.length, 0),
    disconnectAt: fixture.disconnectAt,
    expiresAt: fixture.expiresAt,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [outputPath] = process.argv.slice(2);
  preprovisionLoadRooms({
    endpoint: process.env.EMBER_LOAD_PREPROVISION_URL,
    token: process.env.EMBER_LOAD_PREPROVISION_TOKEN,
    targetId: process.env.EMBER_LOAD_TARGET,
    probeId: process.env.EMBER_LOAD_PROBE_ID,
    sourceSha: process.env.EMBER_SOURCE_SHA,
    runId: process.env.EMBER_LOAD_RUN_ID,
    outputPath,
  }).then((evidence) => {
    console.log(`pre-provisioned ${evidence.roomCount} rooms / ${evidence.logicalClients} clients`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
