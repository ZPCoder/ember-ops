import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PACKAGE_NAMES = Object.freeze({
  protocol: "@zpcoder/ember-protocol",
  sdk: "@zpcoder/ember-sdk",
  config: "@zpcoder/ember-config",
});

async function importInstalled(packageName, expectedVersion) {
  const packageRoot = join(process.cwd(), "node_modules", ...packageName.split("/"));
  const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(packageJson.name, packageName, `${packageName} package identity drifted`);
  assert.equal(packageJson.version, expectedVersion, `${packageName} package version drifted`);
  const entry = packageJson.exports?.["."]?.import ?? packageJson.module ?? packageJson.main;
  assert.equal(typeof entry, "string", `${packageName} has no ESM entrypoint`);
  const module = await import(pathToFileURL(resolve(packageRoot, entry)).href);
  assert.ok(Object.keys(module).length > 0, `${packageName} ESM entrypoint exported nothing`);
  return module;
}

const [matrixPath, section, fixturePath] = process.argv.slice(2);
if (!matrixPath || !new Set(["active", "rollback"]).has(section) || !fixturePath) {
  throw new Error("usage: verify-installed-compatibility.mjs <matrix> <active|rollback> <fixture>");
}

const matrix = JSON.parse(await readFile(resolve(matrixPath), "utf8"));
const fixture = JSON.parse(await readFile(resolve(fixturePath), "utf8"));
assert.equal(fixture.schemaVersion, 1, "fixed replay schemaVersion must be 1");
assert.equal(fixture.protocolVersion, matrix.contracts[section].protocolVersion, "replay wire version differs from matrix");
assert.equal(fixture.clientVersion, matrix.contracts[section].configManifest.minimumClientVersion, "replay client version differs from config floor");

const protocol = await importInstalled(PACKAGE_NAMES.protocol, matrix[section].protocol);
const sdk = await importInstalled(PACKAGE_NAMES.sdk, matrix[section].sdk);
const config = await importInstalled(PACKAGE_NAMES.config, matrix[section].config);
assert.equal(protocol.CURRENT_PROTOCOL_VERSION, fixture.protocolVersion, "installed protocol does not implement matrix wire version");
assert.deepEqual(protocol.checkProtocolVersion(fixture.protocolVersion), { compatible: true, updateRequired: false });
assert.equal(config.checkMinimumClientVersion(fixture.clientVersion, matrix.contracts[section].configManifest).compatible, true);

const finalState = sdk.replayCommands(
  sdk.createMatch({ seed: fixture.seed, matchId: fixture.matchId }),
  fixture.commands,
);
const actualStateDigest = sdk.stateDigest(finalState);
assert.equal(actualStateDigest, fixture.expectedStateDigest, "fixed authoritative replay digest drifted");

console.log(JSON.stringify({
  status: "passed",
  consumer: process.cwd(),
  protocolVersion: fixture.protocolVersion,
  packages: Object.fromEntries(Object.entries(PACKAGE_NAMES).map(([key]) => [key, matrix[section][key]])),
  stateDigest: actualStateDigest,
}));
