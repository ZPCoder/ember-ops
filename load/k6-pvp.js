import http from "k6/http";
import { check, fail, sleep } from "k6";
import execution from "k6/execution";
import { Counter, Rate, Trend } from "k6/metrics";
import {
  getPath,
  normalizeEventEnvelopes,
  renderTemplate,
  validateLoadContract,
} from "./pvp-contract.js";

if (!__ENV.EMBER_PVP_LOAD_CONTRACT) throw new Error("EMBER_PVP_LOAD_CONTRACT is required");
if (!__ENV.EMBER_LOAD_CREDENTIALS_FILE) throw new Error("EMBER_LOAD_CREDENTIALS_FILE is required");
if (!/^https?:\/\//.test(__ENV.EMBER_API_URL ?? "")) throw new Error("EMBER_API_URL must be an absolute HTTP(S) URL");

const contract = JSON.parse(open(__ENV.EMBER_PVP_LOAD_CONTRACT));
const contractErrors = validateLoadContract(contract);
if (contractErrors.length > 0) throw new Error(`invalid PVP load contract: ${contractErrors.join("; ")}`);
const credentials = JSON.parse(open(__ENV.EMBER_LOAD_CREDENTIALS_FILE));
if (credentials?.schemaVersion !== 1 || !Array.isArray(credentials.players)
  || credentials.players.length < contract.logicalClients) {
  throw new Error(`credentials file must contain at least ${contract.logicalClients} players`);
}
const selectedPlayers = credentials.players.slice(0, contract.logicalClients);
if (selectedPlayers.some((player) => typeof player?.token !== "string" || player.token.length < 8
  || typeof player?.deckId !== "string" || player.deckId.length === 0)) {
  throw new Error("every load player must provide a token and deckId");
}
if (new Set(selectedPlayers.map((player) => player.token)).size !== selectedPlayers.length) {
  throw new Error("load player tokens must be unique");
}

const baseUrl = __ENV.EMBER_API_URL.replace(/\/$/, "");
const propagation = new Trend("pvp_state_propagation_ms", true);
const reconnect = new Trend("pvp_reconnect_ms", true);
const pairingErrors = new Rate("pvp_pairing_errors");
const commandErrors = new Rate("pvp_command_errors");
const reconnectErrors = new Rate("pvp_reconnect_errors");
const roomsPaired = new Counter("pvp_rooms_paired");
const logicalClients = new Counter("pvp_logical_clients");
const commandsAccepted = new Counter("pvp_commands_accepted");
const commandsObserved = new Counter("pvp_commands_observed");
const lostAcceptedCommands = new Counter("pvp_lost_accepted_commands");
const duplicateCommandEvents = new Counter("pvp_duplicate_command_events");
const duplicateSettlement = new Counter("pvp_duplicate_settlement");
const missingSettlement = new Counter("pvp_missing_settlement");
const idempotencyViolations = new Counter("pvp_idempotency_violations");

export const options = {
  scenarios: {
    rooms: {
      executor: "shared-iterations",
      vus: contract.roomCount,
      iterations: contract.roomCount,
      maxDuration: "10m",
    },
  },
  thresholds: {
    pvp_state_propagation_ms: ["p(95)<800"],
    pvp_reconnect_ms: ["p(95)<3000"],
    pvp_pairing_errors: ["rate==0"],
    pvp_command_errors: ["rate<0.005"],
    pvp_reconnect_errors: ["rate<0.005"],
    pvp_rooms_paired: [`count>=${contract.roomCount}`],
    pvp_logical_clients: [`count>=${contract.logicalClients}`],
    pvp_commands_accepted: [`count>=${contract.roomCount}`],
    pvp_commands_observed: [`count>=${contract.roomCount}`],
    pvp_lost_accepted_commands: ["count==0"],
    pvp_duplicate_command_events: ["count==0"],
    pvp_duplicate_settlement: ["count==0"],
    pvp_missing_settlement: ["count==0"],
    pvp_idempotency_violations: ["count==0"],
    checks: ["rate>0.995"],
    http_req_failed: ["rate<0.005"],
  },
};

function request(endpoint, values, player, metric, tag) {
  const path = renderTemplate(endpoint.path, values);
  const endpointHeaders = renderTemplate(endpoint.headers ?? {}, values);
  const headers = {
    "content-type": "application/json",
    ...endpointHeaders,
    [contract.auth.header]: renderTemplate(contract.auth.value, { ...values, token: player.token }),
  };
  const body = endpoint.method === "GET" ? null : JSON.stringify(renderTemplate(endpoint.body, values));
  const response = http.request(endpoint.method, `${baseUrl}${path}`, body, { headers, tags: { endpoint: tag } });
  const accepted = endpoint.acceptedStatuses.includes(response.status);
  metric.add(!accepted);
  check(response, { [`${tag} returned an accepted status`]: () => accepted });
  return { response, accepted };
}

function json(response, label) {
  try {
    return response.json();
  } catch (_error) {
    fail(`${label} did not return JSON`);
  }
}

function snapshot(payload, label) {
  const matchId = getPath(payload, contract.snapshotPaths.matchId);
  const stateVersion = getPath(payload, contract.snapshotPaths.stateVersion);
  const cursor = getPath(payload, contract.snapshotPaths.cursor);
  if (typeof matchId !== "string" || matchId.length === 0
    || !Number.isInteger(stateVersion) || stateVersion < 0
    || !Number.isInteger(cursor) || cursor < 0) {
    fail(`${label} did not contain matchId/stateVersion/cursor`);
  }
  return { matchId, stateVersion, cursor };
}

function flatten(envelopes) {
  const events = [];
  for (const envelope of envelopes) {
    for (const event of envelope.events) events.push({ event, cursor: envelope.cursor, stateVersion: envelope.stateVersion });
  }
  return events;
}

function pollForAccepted(player, context, afterCursor, requestId, expectedVersion) {
  let cursor = afterCursor;
  for (let attempt = 0; attempt < contract.polling.attempts; attempt += 1) {
    const polled = request(contract.endpoints.events, { ...context, cursor }, player, commandErrors, "events");
    if (!polled.accepted) return null;
    const envelopes = normalizeEventEnvelopes(json(polled.response, "events"), contract.stream);
    for (const envelope of envelopes) cursor = Math.max(cursor, envelope.cursor);
    const accepted = flatten(envelopes).find(({ event, cursor: eventCursor, stateVersion }) =>
      getPath(event, contract.stream.eventTypePath) === contract.eventTypes.commandAccepted
      && getPath(event, contract.stream.correlationPath) === requestId
      && eventCursor > afterCursor
      && stateVersion > expectedVersion);
    if (accepted) return { accepted, cursor };
    sleep(contract.polling.intervalSeconds);
  }
  return null;
}

function roomFailure(message, metric) {
  metric.add(true);
  fail(message);
}

export default function () {
  const roomIndex = execution.scenario.iterationInTest;
  const playerA = selectedPlayers[roomIndex * 2];
  const playerB = selectedPlayers[roomIndex * 2 + 1];
  if (!playerA || !playerB) roomFailure(`missing credentials for room ${roomIndex}`, pairingErrors);

  const roomKey = `load-room-${roomIndex}-${Date.now()}`;
  const common = { roomKey, protocolVersion: contract.protocolVersion };
  const firstContext = {
    ...common,
    deckId: playerA.deckId,
    requestId: `pair-a-${roomKey}`,
    idempotencyKey: `pair-a-${roomKey}`,
  };
  const first = request(contract.endpoints.pairFirst, firstContext, playerA, pairingErrors, "pair-first");
  if (!first.accepted) roomFailure(`first player failed to create room ${roomIndex}`, pairingErrors);
  const firstSnapshot = snapshot(json(first.response, "pair-first"), "pair-first");

  const secondContext = {
    ...common,
    matchId: firstSnapshot.matchId,
    deckId: playerB.deckId,
    requestId: `pair-b-${roomKey}`,
    idempotencyKey: `pair-b-${roomKey}`,
  };
  const second = request(contract.endpoints.pairSecond, secondContext, playerB, pairingErrors, "pair-second");
  if (!second.accepted) roomFailure(`second player failed to join room ${roomIndex}`, pairingErrors);
  const secondSnapshot = snapshot(json(second.response, "pair-second"), "pair-second");
  if (firstSnapshot.matchId !== secondSnapshot.matchId) {
    roomFailure(`players were not paired into the same room ${roomIndex}`, pairingErrors);
  }
  pairingErrors.add(false);
  roomsPaired.add(1);
  logicalClients.add(2);

  const matchId = secondSnapshot.matchId;
  const expectedVersion = Math.max(firstSnapshot.stateVersion, secondSnapshot.stateVersion);
  const beforeCursor = Math.max(firstSnapshot.cursor, secondSnapshot.cursor);
  const requestId = `concede-${roomKey}`;
  const idempotencyKey = `idem-${requestId}`;
  const commandContext = {
    ...common,
    matchId,
    requestId,
    idempotencyKey,
    expectedVersion,
  };

  const commandStarted = Date.now();
  const command = request(contract.endpoints.command, commandContext, playerA, commandErrors, "command");
  if (!command.accepted) roomFailure(`command was rejected for room ${roomIndex}`, commandErrors);
  commandsAccepted.add(1);
  const commandSnapshot = snapshot(json(command.response, "command"), "command");
  if (commandSnapshot.matchId !== matchId || commandSnapshot.stateVersion <= expectedVersion
    || commandSnapshot.cursor <= beforeCursor) {
    roomFailure(`accepted command did not advance authoritative state for room ${roomIndex}`, commandErrors);
  }
  commandErrors.add(false);

  const observed = pollForAccepted(playerA, { ...common, matchId }, beforeCursor, requestId, expectedVersion);
  if (!observed) {
    lostAcceptedCommands.add(1);
    fail(`accepted command was not observed for room ${roomIndex}`);
  }
  propagation.add(Date.now() - commandStarted);
  commandsObserved.add(1);

  const replay = request(contract.endpoints.command, commandContext, playerA, commandErrors, "command-idempotent-replay");
  if (!replay.accepted) roomFailure(`idempotent command replay failed for room ${roomIndex}`, commandErrors);
  const replaySnapshot = snapshot(json(replay.response, "command replay"), "command replay");
  if (replaySnapshot.stateVersion !== commandSnapshot.stateVersion || replaySnapshot.cursor !== commandSnapshot.cursor) {
    idempotencyViolations.add(1);
  }
  commandErrors.add(false);

  sleep(contract.polling.intervalSeconds);
  const reconnectStarted = Date.now();
  const reconnected = request(
    contract.endpoints.reconnect,
    { ...common, matchId, cursor: 0 },
    playerA,
    reconnectErrors,
    "reconnect",
  );
  if (!reconnected.accepted) roomFailure(`reconnect failed for room ${roomIndex}`, reconnectErrors);
  let envelopes;
  try {
    envelopes = normalizeEventEnvelopes(json(reconnected.response, "reconnect"), contract.stream);
  } catch (_error) {
    roomFailure(`reconnect stream was invalid for room ${roomIndex}`, reconnectErrors);
  }
  const maxCursor = Math.max(0, ...envelopes.map((envelope) => envelope.cursor));
  if (maxCursor < observed.cursor) roomFailure(`reconnect lost cursor for room ${roomIndex}`, reconnectErrors);
  reconnect.add(Date.now() - reconnectStarted);
  reconnectErrors.add(false);

  const events = flatten(envelopes).map(({ event }) => event);
  const acceptedEvents = events.filter((event) =>
    getPath(event, contract.stream.eventTypePath) === contract.eventTypes.commandAccepted
    && getPath(event, contract.stream.correlationPath) === requestId);
  if (acceptedEvents.length > 1) duplicateCommandEvents.add(acceptedEvents.length - 1);
  if (acceptedEvents.length === 0) lostAcceptedCommands.add(1);

  const settlements = events.filter((event) =>
    getPath(event, contract.stream.eventTypePath) === contract.eventTypes.matchEnded);
  if (settlements.length === 0) missingSettlement.add(1);
  if (settlements.length > 1) duplicateSettlement.add(settlements.length - 1);
  if (settlements.length === 1) {
    const settlementId = getPath(settlements[0], contract.stream.settlementIdPath);
    if (typeof settlementId !== "string" || settlementId.length === 0) missingSettlement.add(1);
  }
}
