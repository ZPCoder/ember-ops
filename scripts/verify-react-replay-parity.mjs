import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function stateDigest(state) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(state)));
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

const [clientRoot, fixturePath] = process.argv.slice(2);
if (!clientRoot || !fixturePath) {
  throw new Error("usage: verify-react-replay-parity.mjs <client-root> <fixture>");
}
const fixture = JSON.parse(await readFile(resolve(fixturePath), "utf8"));
const enginePath = join(resolve(clientRoot), "reference-react", "legacy", "lib", "game", "engine.ts");
const { applyCommand, createMatch } = await import(pathToFileURL(enginePath).href);
let state = createMatch({ seed: fixture.seed, matchId: fixture.matchId });
for (const command of fixture.commands) {
  const result = applyCommand(state, command);
  assert.equal(result.accepted, true, `React replay rejected ${command.type}`);
  state = result.state;
}
const actualStateDigest = stateDigest(state);
assert.equal(actualStateDigest, fixture.expectedStateDigest, "React frozen rules differ from the authoritative SDK replay");
console.log(JSON.stringify({
  status: "passed",
  consumer: "react-fallback",
  enginePath,
  commandCount: fixture.commands.length,
  stateDigest: actualStateDigest,
}));
