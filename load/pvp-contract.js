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
  if (contract?.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (contract?.roomCount !== 250) errors.push("roomCount must be 250");
  if (contract?.logicalClients !== 500) errors.push("logicalClients must be 500");
  if (typeof contract?.protocolVersion !== "string" || !/^\d+\.\d+(?:\.\d+)?$/.test(contract.protocolVersion)) {
    errors.push("protocolVersion is invalid");
  }
  if (typeof contract?.auth?.header !== "string" || contract.auth.header.length === 0
    || typeof contract?.auth?.value !== "string" || !contract.auth.value.includes("{token}")) {
    errors.push("auth must define a header and a value containing {token}");
  }
  for (const name of ["pairFirst", "pairSecond", "command", "events", "reconnect"]) {
    validateEndpoint(name, contract?.endpoints?.[name], errors);
  }
  for (const [name, value] of Object.entries(contract?.snapshotPaths ?? {})) {
    if (!new Set(["matchId", "stateVersion", "cursor"]).has(name) || typeof value !== "string" || value.length === 0) {
      errors.push(`snapshotPaths.${name} is invalid`);
    }
  }
  for (const required of ["matchId", "stateVersion", "cursor"]) {
    if (typeof contract?.snapshotPaths?.[required] !== "string") errors.push(`snapshotPaths.${required} is required`);
  }
  if (!new Set(["object", "array"]).has(contract?.stream?.envelopeMode)) errors.push("stream.envelopeMode is invalid");
  for (const name of ["eventsPath", "cursorPath", "stateVersionPath", "eventTypePath", "correlationPath", "settlementIdPath"]) {
    if (typeof contract?.stream?.[name] !== "string" || contract.stream[name].length === 0) {
      errors.push(`stream.${name} is required`);
    }
  }
  for (const name of ["commandAccepted", "matchEnded"]) {
    if (typeof contract?.eventTypes?.[name] !== "string" || contract.eventTypes[name].length === 0) {
      errors.push(`eventTypes.${name} is required`);
    }
  }
  if (!Number.isInteger(contract?.polling?.attempts) || contract.polling.attempts < 1 || contract.polling.attempts > 100) {
    errors.push("polling.attempts must be between 1 and 100");
  }
  if (typeof contract?.polling?.intervalSeconds !== "number" || contract.polling.intervalSeconds <= 0 || contract.polling.intervalSeconds > 1) {
    errors.push("polling.intervalSeconds must be greater than 0 and at most 1");
  }
  return errors;
}

export function getPath(value, path) {
  if (path === "$" || path === "") return value;
  return path.split(".").reduce((current, segment) => {
    if (current === null || current === undefined) return undefined;
    return current[segment];
  }, value);
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
  if (isObject(template)) {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, renderTemplate(value, values)]));
  }
  return template;
}

export function normalizeEventEnvelopes(payload, stream) {
  const envelopes = stream.envelopeMode === "array" ? payload : [payload];
  if (!Array.isArray(envelopes)) throw new Error("event response does not match envelopeMode");
  return envelopes.map((envelope) => {
    const events = getPath(envelope, stream.eventsPath);
    const cursor = getPath(envelope, stream.cursorPath);
    const stateVersion = getPath(envelope, stream.stateVersionPath);
    if (!Array.isArray(events) || !Number.isInteger(cursor) || !Number.isInteger(stateVersion)) {
      throw new Error("event envelope is missing events, cursor, or stateVersion");
    }
    return { envelope, events, cursor, stateVersion };
  });
}
