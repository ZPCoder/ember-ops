const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateEndpoint(name, endpoint, errors) {
  if (!isObject(endpoint)) {
    errors.push(`endpoints.${name} is required`);
    return;
  }
  if (!METHODS.has(endpoint.method)) errors.push(`endpoints.${name}.method is invalid`);
  if (typeof endpoint.path !== "string" || !endpoint.path.startsWith("/") || endpoint.path.startsWith("//")) {
    errors.push(`endpoints.${name}.path must be a relative API path`);
  }
  if (!Array.isArray(endpoint.acceptedStatuses) || endpoint.acceptedStatuses.length === 0
    || endpoint.acceptedStatuses.some((status) => !Number.isInteger(status) || status < 200 || status > 299)) {
    errors.push(`endpoints.${name}.acceptedStatuses must contain successful HTTP statuses`);
  }
  if (endpoint.method !== "GET" && !isObject(endpoint.body)) errors.push(`endpoints.${name}.body is required`);
  if (endpoint.headers !== undefined && !isObject(endpoint.headers)) errors.push(`endpoints.${name}.headers must be an object`);
}

export function validateLoadContract(contract) {
  const errors = [];
  if (contract?.schemaVersion !== 2) errors.push("schemaVersion must be 2");
  if (contract?.roomCount !== 250) errors.push("roomCount must be 250");
  if (contract?.logicalClients !== 500) errors.push("logicalClients must be 500");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(contract?.protocolVersion ?? "")) {
    errors.push("protocolVersion must be canonical major.minor");
  }
  if (typeof contract?.auth?.header !== "string" || contract.auth.header.length === 0
    || typeof contract?.auth?.value !== "string" || !contract.auth.value.includes("{token}")) {
    errors.push("auth must define a header and a value containing {token}");
  }
  validateEndpoint("command", contract?.endpoints?.command, errors);
  if (getPath(contract?.endpoints?.command?.body, "command.type") !== "concede"
    || getPath(contract?.endpoints?.command?.body, "command.player") !== "{seat}") {
    errors.push("command body must submit concede with command.player={seat}");
  }
  if (contract?.endpoints?.command?.headers?.["Idempotency-Key"] !== "{idempotencyKey}") {
    errors.push("command must send Idempotency-Key={idempotencyKey}");
  }
  const websocket = contract?.websocket;
  if (!isObject(websocket) || typeof websocket.path !== "string" || !websocket.path.startsWith("/")) {
    errors.push("websocket.path must be a relative WebSocket path");
  }
  for (const name of ["openTimeoutMs", "messageTimeoutMs", "disconnectCommandDelayMs", "reconnectDelayMs"]) {
    if (!Number.isInteger(websocket?.[name]) || websocket[name] < 1 || websocket[name] > 30_000) {
      errors.push(`websocket.${name} must be between 1 and 30000 milliseconds`);
    }
  }
  if ((websocket?.reconnectDelayMs ?? 0) <= (websocket?.disconnectCommandDelayMs ?? 0)) {
    errors.push("websocket.reconnectDelayMs must be after the offline command delay");
  }
  for (const required of ["matchId", "stateVersion", "cursor"]) {
    if (typeof contract?.snapshotPaths?.[required] !== "string") errors.push(`snapshotPaths.${required} is required`);
  }
  if (!new Set(["object", "array"]).has(contract?.stream?.envelopeMode)) errors.push("stream.envelopeMode is invalid");
  for (const name of ["matchIdPath", "eventsPath", "cursorPath", "stateVersionPath", "eventTypePath", "correlationPath", "settlementIdPath"]) {
    if (typeof contract?.stream?.[name] !== "string" || contract.stream[name].length === 0) errors.push(`stream.${name} is required`);
  }
  for (const name of ["commandAccepted", "matchEnded"]) {
    if (typeof contract?.eventTypes?.[name] !== "string" || contract.eventTypes[name].length === 0) errors.push(`eventTypes.${name} is required`);
  }
  return errors;
}

export function validateRoomFixture(fixture, expected, now = Date.now()) {
  const errors = [];
  if (fixture?.schemaVersion !== 2) errors.push("fixture schemaVersion must be 2");
  for (const field of ["protocolVersion", "targetId", "probeId", "sourceSha"]) {
    if (fixture?.[field] !== expected?.[field]) errors.push(`fixture ${field} does not match the requested load gate`);
  }
  const expiresAt = Date.parse(fixture?.expiresAt ?? "");
  const disconnectAt = Date.parse(fixture?.disconnectAt ?? "");
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 30 * 60_000) {
    errors.push("fixture expiresAt must be future and no more than 30 minutes old-to-live");
  }
  if (!Number.isFinite(disconnectAt) || disconnectAt <= now + 5_000
    || disconnectAt > now + 5 * 60_000 || disconnectAt >= expiresAt) {
    errors.push("fixture disconnectAt must be 5 seconds to 5 minutes in the future and before expiry");
  }
  if (!Array.isArray(fixture?.rooms) || fixture.rooms.length !== 250) errors.push("fixture must contain exactly 250 rooms");
  const tokens = new Set();
  const matches = new Set();
  for (let roomIndex = 0; roomIndex < (fixture?.rooms?.length ?? 0); roomIndex += 1) {
    const room = fixture.rooms[roomIndex];
    if (room?.roomIndex !== roomIndex) errors.push(`room ${roomIndex} has an invalid roomIndex`);
    if (typeof room?.matchId !== "string" || room.matchId.length === 0 || matches.has(room.matchId)) errors.push(`room ${roomIndex} matchId is missing or duplicated`);
    else matches.add(room.matchId);
    if (!Number.isSafeInteger(room?.stateVersion) || room.stateVersion < 0) errors.push(`room ${roomIndex} stateVersion is invalid`);
    if (!Number.isSafeInteger(room?.cursor) || room.cursor < 0) errors.push(`room ${roomIndex} cursor is invalid`);
    if (!Array.isArray(room?.players) || room.players.length !== 2
      || room.players[0]?.seat !== 0 || room.players[1]?.seat !== 1) {
      errors.push(`room ${roomIndex} must contain seats 0 and 1 in order`);
      continue;
    }
    for (const player of room.players) {
      if (typeof player.token !== "string" || player.token.length < 8 || tokens.has(player.token)) errors.push(`room ${roomIndex} has a missing or duplicate player token`);
      else tokens.add(player.token);
    }
  }
  return errors;
}

export function getPath(value, path) {
  if (path === "$" || path === "") return value;
  return path.split(".").reduce((current, segment) => current === null || current === undefined ? undefined : current[segment], value);
}

function renderString(template, values) {
  const exact = template.match(/^\{([A-Za-z][A-Za-z0-9]*)\}$/);
  if (exact) {
    if (!(exact[1] in values)) throw new Error(`missing template value ${exact[1]}`);
    return values[exact[1]];
  }
  return template.replaceAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, name) => {
    if (!(name in values)) throw new Error(`missing template value ${name}`);
    return String(values[name]);
  });
}

export function renderTemplate(template, values) {
  if (typeof template === "string") return renderString(template, values);
  if (Array.isArray(template)) return template.map((value) => renderTemplate(value, values));
  if (isObject(template)) return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, renderTemplate(value, values)]));
  return template;
}

export function normalizeEventEnvelopes(payload, stream) {
  const envelopes = stream.envelopeMode === "array" ? payload : [payload];
  if (!Array.isArray(envelopes)) throw new Error("event response does not match envelopeMode");
  return envelopes.map((envelope) => {
    const matchId = getPath(envelope, stream.matchIdPath);
    const events = getPath(envelope, stream.eventsPath);
    const cursor = getPath(envelope, stream.cursorPath);
    const stateVersion = getPath(envelope, stream.stateVersionPath);
    if (typeof matchId !== "string" || !Array.isArray(events) || !Number.isInteger(cursor) || !Number.isInteger(stateVersion)) {
      throw new Error("event envelope is missing matchId, events, cursor, or stateVersion");
    }
    return { envelope, matchId, events, cursor, stateVersion };
  });
}
