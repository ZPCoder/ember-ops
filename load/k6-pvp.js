import http from "k6/http";
import ws from "k6/ws";
import { check, fail, sleep } from "k6";
import { SharedArray } from "k6/data";
import execution from "k6/execution";
import { Counter, Rate, Trend } from "k6/metrics";
import { getPath, normalizeEventEnvelopes, renderTemplate, validateLoadContract, validateRoomFixture } from "./pvp-contract.js";

for (const name of [
  "EMBER_PVP_LOAD_CONTRACT", "EMBER_LOAD_ROOM_FIXTURE", "EMBER_API_URL", "EMBER_WS_URL",
  "EMBER_LOAD_TARGET", "EMBER_LOAD_PROBE_ID", "EMBER_LOAD_RUN_ID", "EMBER_SOURCE_SHA", "EMBER_K6_EVIDENCE_PATH",
]) {
  if (!__ENV[name]) throw new Error(`${name} is required`);
}
if (!/^https:\/\//.test(__ENV.EMBER_API_URL) || !/^wss:\/\//.test(__ENV.EMBER_WS_URL)) {
  throw new Error("load gates require absolute HTTPS and WSS endpoints");
}
if (!/^[a-f0-9]{40}$/.test(__ENV.EMBER_SOURCE_SHA)) throw new Error("EMBER_SOURCE_SHA must be a full commit SHA");
if (!/^[A-Za-z0-9._-]+$/.test(__ENV.EMBER_LOAD_RUN_ID)) throw new Error("EMBER_LOAD_RUN_ID is invalid");

const contract = JSON.parse(open(__ENV.EMBER_PVP_LOAD_CONTRACT));
const contractErrors = validateLoadContract(contract);
if (contractErrors.length > 0) throw new Error(`invalid PVP load contract: ${contractErrors.join("; ")}`);
const roomFixture = JSON.parse(open(__ENV.EMBER_LOAD_ROOM_FIXTURE));
const fixtureErrors = validateRoomFixture(roomFixture, {
  protocolVersion: contract.protocolVersion,
    targetId: __ENV.EMBER_LOAD_TARGET,
    probeId: __ENV.EMBER_LOAD_PROBE_ID,
    sourceSha: __ENV.EMBER_SOURCE_SHA,
    runId: __ENV.EMBER_LOAD_RUN_ID,
});
if (fixtureErrors.length > 0) throw new Error(`invalid pre-provisioned room fixture: ${fixtureErrors.join("; ")}`);
const clients = new SharedArray("pre-provisioned-pvp-clients-v2", () => roomFixture.rooms.flatMap((room) =>
  room.players.map((player) => ({
    roomIndex: room.roomIndex,
    matchId: room.matchId,
    stateVersion: room.stateVersion,
    cursor: room.cursor,
    seat: player.seat,
    token: player.token,
  }))));

const baseUrl = __ENV.EMBER_API_URL.replace(/\/$/, "");
const wsBaseUrl = __ENV.EMBER_WS_URL.replace(/\/$/, "");
const propagation = new Trend("pvp_state_propagation_ms", true);
const reconnect = new Trend("pvp_reconnect_ms", true);
const errors = new Rate("pvp_error_rate");
const clientsStarted = new Counter("pvp_clients_started");
const roomsSeen = new Counter("pvp_rooms_seen");
const wsSessions = new Counter("pvp_ws_sessions");
const initialOpened = new Counter("pvp_initial_ws_opened");
const initialAuthoritative = new Counter("pvp_initial_authoritative");
const initialClosed = new Counter("pvp_initial_ws_closed");
const reconnectOpened = new Counter("pvp_reconnect_ws_opened");
const reconnectCaughtUp = new Counter("pvp_reconnect_caught_up");
const propagationSamples = new Counter("pvp_state_propagation_samples");
const commandsAccepted = new Counter("pvp_commands_accepted");
const commandsObserved = new Counter("pvp_commands_observed");
const settlementsObserved = new Counter("pvp_settlements_observed");
const lostCommands = new Counter("pvp_lost_accepted_commands");
const duplicateCommands = new Counter("pvp_duplicate_command_events");
const duplicateSettlements = new Counter("pvp_duplicate_settlement");
const missingSettlements = new Counter("pvp_missing_settlement");
const idempotencyViolations = new Counter("pvp_idempotency_violations");
const websocketFailures = new Counter("pvp_websocket_failures");
const earlyInitialCloses = new Counter("pvp_early_initial_closes");
const lateInitialOpens = new Counter("pvp_late_initial_opens");
const websocketOpenTimeouts = new Counter("pvp_websocket_open_timeouts");

export const options = {
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "count"],
  scenarios: {
    clients: {
      executor: "per-vu-iterations",
      vus: 500,
      iterations: 1,
      maxDuration: "10m",
    },
  },
  thresholds: {
    vus_max: ["value==500"],
    iterations: ["count==500"],
    dropped_iterations: ["count==0"],
    pvp_clients_started: ["count==500"],
    pvp_rooms_seen: ["count==250"],
    pvp_ws_sessions: ["count==1000"],
    pvp_initial_ws_opened: ["count==500"],
    pvp_initial_authoritative: ["count==500"],
    pvp_initial_ws_closed: ["count==500"],
    pvp_reconnect_ws_opened: ["count==500"],
    pvp_reconnect_caught_up: ["count==500"],
    pvp_state_propagation_samples: ["count==500"],
    pvp_commands_accepted: ["count==250"],
    pvp_commands_observed: ["count==500"],
    pvp_settlements_observed: ["count==500"],
    pvp_state_propagation_ms: ["p(95)<=800"],
    pvp_reconnect_ms: ["p(95)<=3000"],
    pvp_error_rate: ["rate<0.005"],
    pvp_lost_accepted_commands: ["count==0"],
    pvp_duplicate_command_events: ["count==0"],
    pvp_duplicate_settlement: ["count==0"],
    pvp_missing_settlement: ["count==0"],
    pvp_idempotency_violations: ["count==0"],
    pvp_websocket_failures: ["count==0"],
    pvp_early_initial_closes: ["count==0"],
    pvp_late_initial_opens: ["count==0"],
    pvp_websocket_open_timeouts: ["count==0"],
    checks: ["rate>0.995"],
    http_req_failed: ["rate<0.005"],
  },
};

function failure(message) {
  errors.add(true);
  fail(message);
}

function authHeaders(client) {
  return { [contract.auth.header]: renderTemplate(contract.auth.value, { token: client.token }) };
}

function validateEnvelope(payload, client, minimumCursor, minimumVersion) {
  const envelopes = normalizeEventEnvelopes(payload, contract.stream);
  let previousCursor = minimumCursor;
  let previousVersion = minimumVersion;
  for (const envelope of envelopes) {
    if (envelope.matchId !== client.matchId || envelope.cursor < previousCursor || envelope.stateVersion < previousVersion) {
      failure(`non-monotonic or cross-match WebSocket envelope for room ${client.roomIndex}`);
    }
    previousCursor = envelope.cursor;
    previousVersion = envelope.stateVersion;
  }
  return envelopes;
}

function command(client, requestId, expectedVersion, expectedCursor) {
  const idempotencyKey = `idem-${requestId}`;
  const values = { matchId: client.matchId, protocolVersion: contract.protocolVersion, requestId, idempotencyKey, expectedVersion, seat: client.seat };
  const response = http.request(contract.endpoints.command.method,
    `${baseUrl}${renderTemplate(contract.endpoints.command.path, values)}`,
    JSON.stringify(renderTemplate(contract.endpoints.command.body, values)), {
      headers: {
        "content-type": "application/json",
        ...renderTemplate(contract.endpoints.command.headers, values),
        ...authHeaders(client),
      },
      tags: { endpoint: "pvp-command" },
    });
  const accepted = contract.endpoints.command.acceptedStatuses.includes(response.status);
  check(response, { "authoritative command accepted": () => accepted });
  if (!accepted) failure(`concede was rejected for room ${client.roomIndex}`);
  let snapshot;
  try { snapshot = response.json(); } catch { failure("command response was not JSON"); }
  const stateVersion = getPath(snapshot, contract.snapshotPaths.stateVersion);
  const cursor = getPath(snapshot, contract.snapshotPaths.cursor);
  if (getPath(snapshot, contract.snapshotPaths.matchId) !== client.matchId
    || !Number.isInteger(stateVersion) || stateVersion <= expectedVersion
    || !Number.isInteger(cursor) || cursor <= expectedCursor) {
    failure(`command did not advance authoritative state for room ${client.roomIndex}`);
  }
  return { idempotencyKey, stateVersion, cursor };
}

function connectInitial(client, state) {
  const values = { matchId: client.matchId, cursor: state.cursor };
  const connectStarted = Date.now();
  const disconnectAt = Date.parse(roomFixture.disconnectAt);
  const waitMs = disconnectAt - connectStarted;
  if (waitMs <= 0) failure("pre-provisioned disconnectAt elapsed before initial WebSocket opened");
  const response = ws.connect(`${wsBaseUrl}${renderTemplate(contract.websocket.path, values)}`, { headers: authHeaders(client) }, (socket) => {
    let authoritative = false;
    socket.on("open", () => {
      const openedAt = Date.now();
      if (openedAt - connectStarted > contract.websocket.openTimeoutMs) {
        websocketOpenTimeouts.add(1);
        socket.close();
        failure(`initial WebSocket exceeded open timeout for room ${client.roomIndex}`);
      }
      if (openedAt >= disconnectAt) {
        lateInitialOpens.add(1);
        socket.close();
        failure(`initial WebSocket opened after the shared disconnect window for room ${client.roomIndex}`);
      }
      initialOpened.add(1);
      wsSessions.add(1);
    });
    socket.on("message", (message) => {
      let envelopes;
      try { envelopes = validateEnvelope(JSON.parse(message), client, state.cursor, state.stateVersion); }
      catch (error) { websocketFailures.add(1); socket.close(); failure(String(error)); }
      for (const envelope of envelopes) {
        state.cursor = Math.max(state.cursor, envelope.cursor);
        state.stateVersion = Math.max(state.stateVersion, envelope.stateVersion);
      }
      if (!authoritative) { authoritative = true; initialAuthoritative.add(1); }
    });
    socket.on("error", () => { websocketFailures.add(1); });
    socket.setTimeout(() => {
      if (!authoritative) websocketFailures.add(1);
      socket.close();
    }, Math.max(1, disconnectAt - Date.now()));
  });
  if (response?.status !== 101) failure(`initial WebSocket upgrade failed for room ${client.roomIndex}`);
  if (Date.now() < disconnectAt) {
    earlyInitialCloses.add(1);
    failure(`initial WebSocket closed before the shared disconnect window for room ${client.roomIndex}`);
  }
  initialClosed.add(1);
}

function connectResume(client, state, requestId, propagationStartedAt) {
  const reconnectStarted = Date.now();
  const values = { matchId: client.matchId, cursor: state.cursor };
  let caughtUp = false;
  let acceptedCount = 0;
  let settlementCount = 0;
  const response = ws.connect(`${wsBaseUrl}${renderTemplate(contract.websocket.path, values)}`, { headers: authHeaders(client) }, (socket) => {
    socket.on("open", () => {
      if (Date.now() - reconnectStarted > contract.websocket.openTimeoutMs) {
        websocketOpenTimeouts.add(1);
        socket.close();
        failure(`reconnect WebSocket exceeded open timeout for room ${client.roomIndex}`);
      }
      reconnectOpened.add(1);
      wsSessions.add(1);
    });
    socket.on("message", (message) => {
      let envelopes;
      try { envelopes = validateEnvelope(JSON.parse(message), client, state.cursor, state.stateVersion); }
      catch (error) { websocketFailures.add(1); socket.close(); failure(String(error)); }
      for (const envelope of envelopes) {
        state.cursor = Math.max(state.cursor, envelope.cursor);
        state.stateVersion = Math.max(state.stateVersion, envelope.stateVersion);
        for (const event of envelope.events) {
          const type = getPath(event, contract.stream.eventTypePath);
          if (type === contract.eventTypes.commandAccepted
            && getPath(event, contract.stream.correlationPath) === requestId) acceptedCount += 1;
          if (type === contract.eventTypes.matchEnded) {
            settlementCount += 1;
            if (!getPath(event, contract.stream.settlementIdPath)) missingSettlements.add(1);
          }
        }
      }
      if (!caughtUp && acceptedCount >= 1 && settlementCount >= 1) {
        caughtUp = true;
        reconnect.add(Date.now() - reconnectStarted);
        reconnectCaughtUp.add(1);
        propagation.add(Date.now() - propagationStartedAt);
        propagationSamples.add(1);
        socket.setTimeout(() => socket.close(), contract.websocket.duplicateObservationMs);
      }
    });
    socket.on("error", () => { websocketFailures.add(1); });
    socket.setTimeout(() => socket.close(), contract.websocket.messageTimeoutMs);
  });
  if (response?.status !== 101) failure(`reconnect WebSocket upgrade failed for room ${client.roomIndex}`);
  if (!caughtUp) { lostCommands.add(1); failure(`reconnect did not catch up room ${client.roomIndex}`); }
  if (acceptedCount === 0) lostCommands.add(1);
  if (acceptedCount > 1) duplicateCommands.add(acceptedCount - 1);
  if (settlementCount === 0) missingSettlements.add(1);
  if (settlementCount > 1) duplicateSettlements.add(settlementCount - 1);
  if (acceptedCount === 1) commandsObserved.add(1);
  if (settlementCount === 1) settlementsObserved.add(1);
  errors.add(false);
}

export default function () {
  const clientIndex = execution.vu.idInTest - 1;
  const client = clients[clientIndex];
  if (!client || clientIndex >= 500) failure(`VU ${execution.vu.idInTest} has no unique pre-provisioned player`);
  if (clientIndex === 0) {
    lostCommands.add(0);
    duplicateCommands.add(0);
    duplicateSettlements.add(0);
    missingSettlements.add(0);
    idempotencyViolations.add(0);
    websocketFailures.add(0);
    earlyInitialCloses.add(0);
    lateInitialOpens.add(0);
    websocketOpenTimeouts.add(0);
  }
  clientsStarted.add(1);
  if (client.seat === 0) roomsSeen.add(1);
  const state = { cursor: client.cursor, stateVersion: client.stateVersion };
  const actorSeat = client.roomIndex % 2;
  const requestId = `concede-${__ENV.EMBER_LOAD_RUN_ID}-${client.roomIndex}`;
  connectInitial(client, state);
  const disconnectAt = Date.parse(roomFixture.disconnectAt);
  let propagationStartedAt = disconnectAt + contract.websocket.disconnectCommandDelayMs;
  if (client.seat === actorSeat) {
    const delay = disconnectAt + contract.websocket.disconnectCommandDelayMs - Date.now();
    if (delay > 0) sleep(delay / 1000);
    propagationStartedAt = Date.now();
    const first = command(client, requestId, state.stateVersion, state.cursor);
    commandsAccepted.add(1);
    const replay = command(client, requestId, state.stateVersion, state.cursor);
    if (replay.stateVersion !== first.stateVersion || replay.cursor !== first.cursor) idempotencyViolations.add(1);
  }
  const reconnectDelay = disconnectAt + contract.websocket.reconnectDelayMs - Date.now();
  if (reconnectDelay > 0) sleep(reconnectDelay / 1000);
  connectResume(client, state, requestId, propagationStartedAt);
}

export function handleSummary(data) {
  const required = Object.keys(options.thresholds);
  const metrics = Object.fromEntries(required.map((name) => [name, data.metrics[name] ?? null]));
  const thresholdFailures = required.filter((name) => {
    const thresholds = data.metrics[name]?.thresholds;
    return !thresholds || Object.values(thresholds).some((threshold) => threshold.ok !== true);
  });
  return {
    [__ENV.EMBER_K6_EVIDENCE_PATH]: JSON.stringify({
      schemaVersion: 1,
      status: thresholdFailures.length === 0 ? "passed" : "failed",
      generatedAt: new Date().toISOString(),
      sourceSha: __ENV.EMBER_SOURCE_SHA,
      targetId: __ENV.EMBER_LOAD_TARGET,
      probeId: __ENV.EMBER_LOAD_PROBE_ID,
      runId: __ENV.EMBER_LOAD_RUN_ID,
      protocolVersion: contract.protocolVersion,
      configuredVus: 500,
      configuredRooms: 250,
      thresholdFailures,
      metrics,
    }, null, 2),
  };
}
