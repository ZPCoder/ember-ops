import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { REPOSITORIES } from "../scripts/checkout-compatible.mjs";
import { runCompatibility } from "../scripts/run-compatible.mjs";

async function createFixture(temporary) {
  const matrix = JSON.parse(await readFile(new URL("../compatibility/versions.json", import.meta.url), "utf8"));
  const cards = Array.from({ length: 1_000 }, (_value, index) => ({ id: `card-${index}` }));
  const bundle = Buffer.from(`${JSON.stringify(cards)}\n`);
  const digest = createHash("sha256").update(bundle).digest("hex");
  matrix.contracts.active.configManifest.sha256 = digest;
  matrix.contracts.rollback.configManifest.sha256 = digest;
  const matrixPath = join(temporary, "versions.json");
  const matrixBytes = Buffer.from(`${JSON.stringify(matrix, null, 2)}\n`);
  await writeFile(matrixPath, matrixBytes);

  const workspaceBase = join(temporary, "workspaces");
  await mkdir(workspaceBase, { recursive: true });
  const workspaceRoot = await mkdtemp(join(workspaceBase, "ember-compat-active-"));
  const repositories = {};
  for (const [key, definition] of Object.entries(REPOSITORIES)) {
    const path = join(workspaceRoot, definition.repository);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "package.json"), JSON.stringify({ name: definition.packageName, version: "0.1.0" }));
    const sha = createHash("sha1").update(definition.repository).digest("hex");
    repositories[key] = {
      repository: `ZPCoder/${definition.repository}`,
      packageName: definition.packageName,
      version: "0.1.0",
      tag: "v0.1.0",
      sha,
      path,
    };
  }

  const configPath = repositories.config.path;
  await mkdir(join(configPath, "dist", "bundles"), { recursive: true });
  await mkdir(join(configPath, "manifests"), { recursive: true });
  await writeFile(join(configPath, "dist", "bundles", "cards-1.0.0.json"), bundle);
  await writeFile(join(configPath, "manifests", "config-1.0.0.json"), JSON.stringify({
    ...matrix.contracts.active.configManifest,
    bundleUrl: "https://assets.invalid/cards.json",
    size: bundle.byteLength,
  }));
  await mkdir(join(repositories.backendAdmin.path, "migrations", "canonical"), { recursive: true });
  await writeFile(join(repositories.backendAdmin.path, "migrations", "canonical", "0000_canonical.sql"), "SELECT 1;\n");

  const checkoutEvidencePath = join(temporary, "checkout.json");
  const workspaceMarker = {
    schemaVersion: 1,
    id: "fixture-workspace",
    section: "active",
    matrixSha256: createHash("sha256").update(matrixBytes).digest("hex"),
    createdBy: "ember-ops/checkout-compatible",
  };
  await writeFile(join(workspaceRoot, ".ember-compat-workspace.json"), JSON.stringify(workspaceMarker));
  await writeFile(checkoutEvidencePath, JSON.stringify({
    schemaVersion: 1,
    status: "passed",
    section: "active",
    matrixSha256: workspaceMarker.matrixSha256,
    packages: matrix.active,
    contracts: matrix.contracts.active,
    workspaceRoot,
    workspaceMarker,
    repositories,
  }));
  return { matrixPath, checkoutEvidencePath, workspaceRoot, repositories };
}

function fakeGateRunner(commands, repositories, failProtocol = false) {
  return async (command, args, options) => {
    commands.push({ command, args: [...args], cwd: options.cwd });
    const key = Object.entries(repositories).find(([_key, repository]) => repository.path === options.cwd)?.[0];
    let stdout = "";
    let exitCode = 0;
    if (command === "git" && args[0] === "rev-parse") stdout = `${repositories[key].sha}\n`;
    if (command === "git" && args[0] === "describe") stdout = "v0.1.0\n";
    if (command === "npm" && key === "sdk" && args.length === 1 && args[0] === "test") stdout = "# tests 239\n# pass 239\n";
    if (command === "node" && key === "sdk") stdout = "# tests 2\n# pass 2\n";
    if (command === "sqlite3") stdout = "1\n";
    if (failProtocol && command === "npm" && key === "protocol" && args.length === 1 && args[0] === "test") {
      exitCode = 1;
    }
    const result = { command, args, cwd: options.cwd, stdout, stderr: exitCode ? "simulated failure" : "", exitCode, durationMs: 1 };
    if (exitCode !== 0) {
      const error = new Error("simulated protocol failure");
      error.result = result;
      throw error;
    }
    return result;
  };
}

test("executes real commands for every repository and preserves SHA evidence", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "ember-run-gates-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const fixture = await createFixture(temporary);
  const commands = [];
  const evidencePath = join(temporary, "gates.json");
  const result = await runCompatibility({
    matrixPath: fixture.matrixPath,
    checkoutEvidencePath: fixture.checkoutEvidencePath,
    evidencePath,
    commandRunner: fakeGateRunner(commands, fixture.repositories),
  });

  assert.equal(result.status, "passed-automated-boundaries");
  assert.equal(result.releaseReady, false);
  assert.equal(result.workspaceCleaned, true);
  await assert.rejects(access(fixture.workspaceRoot));
  assert.equal(commands.filter(({ command, args }) => command === "npm" && args[0] === "ci").length, 7);
  assert.ok(commands.some(({ command, args, cwd }) => command === "npm" && args.join(" ") === "run check:generated" && cwd.endsWith("ember-protocol")));
  assert.ok(commands.some(({ command, args, cwd }) => command === "npm" && args.join(" ") === "run check:compat" && cwd.endsWith("ember-protocol")));
  assert.ok(commands.some(({ command, args, cwd }) => command === "npm" && args.join(" ") === "run typecheck:ci" && cwd.endsWith("ember-client")));
  assert.ok(commands.some(({ command }) => command === "sqlite3"));
  assert.ok(commands.some(({ command, args, cwd }) => command === "npm" && args.join(" ") === "run validate" && cwd.endsWith("ember-data")));
  const persisted = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.equal(persisted.repositories.sdk.sha, fixture.repositories.sdk.sha);
  assert.ok(persisted.repositories.sdk.gates.some((gate) => gate.name === "run-239-sdk-tests" && gate.command === "npm"));
  assert.equal(persisted.repositories.config.gates.find((gate) => gate.name === "verify-1000-card-hashed-bundle").cardCount, 1_000);
  assert.equal(persisted.requiredExternalGates[0].status, "required-not-run-here");
});

test("a repository command failure stops later gates and still cleans the workspace", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "ember-run-failure-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const fixture = await createFixture(temporary);
  const commands = [];
  const evidencePath = join(temporary, "gates.json");
  await assert.rejects(runCompatibility({
    matrixPath: fixture.matrixPath,
    checkoutEvidencePath: fixture.checkoutEvidencePath,
    evidencePath,
    commandRunner: fakeGateRunner(commands, fixture.repositories, true),
  }), /simulated protocol failure/);
  assert.equal(commands.some(({ cwd, command, args }) => cwd.endsWith("ember-sdk") && command === "npm" && args[0] === "test"), false);
  await assert.rejects(access(fixture.workspaceRoot));
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.workspaceCleaned, true);
  assert.equal(evidence.repositories.protocol.gates.find((gate) => gate.name === "build-and-test-protocol").status, "failed");
});
