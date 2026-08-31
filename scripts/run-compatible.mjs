import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPOSITORIES } from "./checkout-compatible.mjs";
import { validateMatrix } from "./check-matrix.mjs";
import { commandEvidence, runProcess, sanitizeError, writeJsonAtomic } from "./lib/process.mjs";

const INSTALL_ARGS = ["ci", "--ignore-scripts", "--no-audit", "--no-fund"];

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertInsideWorkspace(workspaceRoot, repositoryPath) {
  const root = resolve(workspaceRoot);
  const target = resolve(repositoryPath);
  const child = relative(root, target);
  if (!child || child.startsWith("..") || isAbsolute(child)) {
    throw new Error(`repository path is outside the isolated workspace: ${target}`);
  }
  return target;
}

function testCount(output, expected) {
  const normalized = output.replaceAll("\r", "");
  return new RegExp(`(?:#|ℹ)\\s*tests\\s+${expected}\\b`, "u").test(normalized);
}

async function verifyConfig(repositoryPath, contract) {
  const manifestPath = join(repositoryPath, "manifests", `config-${contract.configManifest.version}.json`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const field of ["version", "minimumClientVersion", "sha256"]) {
    if (manifest[field] !== contract.configManifest[field]) {
      throw new Error(`config manifest ${field} does not match the registered contract`);
    }
  }
  const bundlePath = join(repositoryPath, "dist", "bundles", `cards-${manifest.version}.json`);
  const bytes = await readFile(bundlePath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== manifest.size) throw new Error(`config bundle size ${bytes.byteLength} does not match ${manifest.size}`);
  if (digest !== manifest.sha256) throw new Error(`config bundle SHA-256 ${digest} does not match ${manifest.sha256}`);
  const cards = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(cards) || cards.length !== 1_000) throw new Error("config bundle must contain exactly 1000 cards");
  return { manifestPath, bundlePath, cardCount: cards.length, size: bytes.byteLength, sha256: digest };
}

function processResult(result, command, args, cwd) {
  return {
    command,
    args,
    cwd,
    startedAt: result.startedAt ?? new Date().toISOString(),
    durationMs: result.durationMs ?? 0,
    exitCode: result.exitCode ?? 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export async function runCompatibility(options) {
  const {
    matrixPath,
    checkoutEvidencePath = "evidence/checkout.json",
    evidencePath = "evidence/gates.json",
    commandRunner = runProcess,
    env = process.env,
  } = options;
  if (!matrixPath) throw new Error("matrixPath is required");

  const matrixBytes = await readFile(matrixPath);
  const matrix = JSON.parse(matrixBytes.toString("utf8"));
  const errors = validateMatrix(matrix);
  if (errors.length > 0) throw new Error(`invalid compatibility matrix: ${errors.join("; ")}`);
  const checkout = JSON.parse(await readFile(checkoutEvidencePath, "utf8"));
  if (checkout.status !== "passed") throw new Error("checkout evidence is not passed");
  if (!new Set(["active", "rollback"]).has(checkout.section)) throw new Error("checkout evidence section is invalid");
  const section = checkout.section;
  const matrixSha256 = createHash("sha256").update(matrixBytes).digest("hex");
  if (checkout.matrixSha256 !== matrixSha256) throw new Error("checkout evidence was produced from a different matrix file");
  if (!sameJson(checkout.packages, matrix[section])) throw new Error("checkout package tuple differs from the matrix");
  if (!sameJson(checkout.contracts, matrix.contracts[section])) throw new Error("checkout contract tuple differs from the matrix");
  if (typeof checkout.workspaceRoot !== "string") throw new Error("checkout evidence has no workspace root");
  const workspaceRoot = resolve(checkout.workspaceRoot);
  if (!basename(workspaceRoot).startsWith(`ember-compat-${section}-`)) {
    throw new Error("checkout workspace does not have the guarded compatibility prefix");
  }
  const workspaceMarker = JSON.parse(await readFile(join(workspaceRoot, ".ember-compat-workspace.json"), "utf8"));
  if (!sameJson(workspaceMarker, checkout.workspaceMarker)
    || workspaceMarker.createdBy !== "ember-ops/checkout-compatible"
    || workspaceMarker.section !== section
    || workspaceMarker.matrixSha256 !== matrixSha256) {
    throw new Error("checkout workspace marker is missing or does not match the evidence");
  }

  const evidence = {
    schemaVersion: 1,
    status: "running",
    releaseReady: false,
    section,
    matrixSha256,
    packages: matrix[section],
    contracts: matrix.contracts[section],
    checkoutEvidencePath: resolve(checkoutEvidencePath),
    startedAt: new Date().toISOString(),
    repositories: {},
    requiredExternalGates: [{
      id: "cocos-creator-3.8.8-web-build",
      status: "required-not-run-here",
      workflowJob: "creator-editor-required",
      runnerLabels: ["self-hosted", "cocos-creator-3.8.8"],
      reason: "Cocos Creator is licensed editor software and cannot be represented by the Ubuntu TypeScript gate.",
    }],
  };

  const runGate = async (key, name, command, args) => {
    const repository = evidence.repositories[key];
    try {
      const raw = await commandRunner(command, args, {
        cwd: repository.path,
        env,
      });
      const result = processResult(raw, command, args, repository.path);
      repository.gates.push(commandEvidence(result, name));
      return result;
    } catch (error) {
      const result = error?.result
        ? processResult(error.result, command, args, repository.path)
        : { command, args, cwd: repository.path, exitCode: 1, stdout: "", stderr: sanitizeError(error) };
      repository.gates.push(commandEvidence(result, name));
      throw error;
    }
  };

  const addAssertion = (key, name, details) => {
    evidence.repositories[key].gates.push({ name, type: "assertion", status: "passed", ...details });
  };

  try {
    for (const [key, definition] of Object.entries(REPOSITORIES)) {
      const checkoutRepository = checkout.repositories?.[key];
      if (!checkoutRepository) throw new Error(`checkout evidence is missing ${key}`);
      const repositoryPath = assertInsideWorkspace(workspaceRoot, checkoutRepository.path);
      const version = matrix[section][key];
      const tag = `v${version}`;
      const expectedSha = checkoutRepository.sha;
      if (!/^[a-f0-9]{40}$/.test(expectedSha)) throw new Error(`${key} checkout SHA is invalid`);
      const packageJson = JSON.parse(await readFile(join(repositoryPath, "package.json"), "utf8"));
      if (packageJson.name !== definition.packageName || packageJson.version !== version) {
        throw new Error(`${key} package identity changed after checkout`);
      }

      evidence.repositories[key] = {
        repository: checkoutRepository.repository,
        packageName: definition.packageName,
        version,
        tag,
        sha: expectedSha,
        path: repositoryPath,
        status: "running",
        gates: [],
      };
      const head = (await runGate(key, "verify-checkout-sha", "git", ["rev-parse", "HEAD"])).stdout.trim();
      if (head !== expectedSha) throw new Error(`${key} HEAD drifted after checkout`);
      const exactTag = (await runGate(key, "verify-exact-tag", "git", ["describe", "--tags", "--exact-match", "HEAD"])).stdout.trim();
      if (exactTag !== tag) throw new Error(`${key} no longer resolves to ${tag}`);
      addAssertion(key, "package-version-matches-tag", { expectedVersion: version, actualVersion: packageJson.version });
    }

    await runGate("protocol", "install-locked-dependencies", "npm", INSTALL_ARGS);
    await runGate("protocol", "check-generated-contracts", "npm", ["run", "check:generated"]);
    await runGate("protocol", "check-backward-compatibility", "npm", ["run", "check:compat"]);
    await runGate("protocol", "build-and-test-protocol", "npm", ["test"]);

    await runGate("sdk", "install-locked-dependencies", "npm", INSTALL_ARGS);
    const sdkTest = await runGate("sdk", "run-239-sdk-tests", "npm", ["test"]);
    if (!testCount(`${sdkTest.stdout}\n${sdkTest.stderr}`, 239)) throw new Error("SDK test output did not prove exactly 239 tests");
    addAssertion("sdk", "sdk-test-count", { expected: 239, actual: 239 });
    const replay = await runGate("sdk", "run-fixed-replay-tests", "node", ["--test", "dist/test/replay.test.js"]);
    if (!testCount(`${replay.stdout}\n${replay.stderr}`, 2)) throw new Error("fixed replay gate did not prove exactly 2 replay tests");
    addAssertion("sdk", "fixed-replay-test-count", { expected: 2, actual: 2 });
    await runGate("sdk", "verify-publishable-package", "npm", ["run", "pack:check"]);

    await runGate("config", "install-locked-dependencies", "npm", INSTALL_ARGS);
    await runGate("config", "build-and-test-config", "npm", ["test"]);
    const configEvidence = await verifyConfig(evidence.repositories.config.path, matrix.contracts[section]);
    addAssertion("config", "verify-1000-card-hashed-bundle", configEvidence);

    await runGate("client", "install-locked-dependencies", "npm", INSTALL_ARGS);
    await runGate("client", "run-client-boundary-tests", "npm", ["test"]);
    await runGate("client", "typecheck-cocos-client", "npm", ["run", "typecheck:ci"]);
    addAssertion("client", "cocos-editor-build-delegated", {
      status: "required-external",
      workflowJob: "creator-editor-required",
    });

    await runGate("backendAdmin", "install-locked-dependencies", "npm", INSTALL_ARGS);
    await runGate("backendAdmin", "typecheck-and-test-backend", "npm", ["run", "check"]);
    const migrationPath = join(evidence.repositories.backendAdmin.path, "migrations", "canonical", "0000_canonical.sql");
    const sqlite = await runGate("backendAdmin", "apply-and-verify-canonical-sqlite-migration", "sqlite3", [
      ":memory:",
      ".bail on",
      `.read ${migrationPath}`,
      "PRAGMA foreign_key_check;",
      "SELECT CASE count(*) WHEN 1 THEN value ELSE 'invalid' END FROM schema_metadata WHERE key='canonical_schema_version';",
    ]);
    if (sqlite.stdout.trim() !== "1") throw new Error("canonical SQLite migration did not report schema version 1");
    addAssertion("backendAdmin", "canonical-schema-version", { expected: "1", actual: sqlite.stdout.trim() });

    await runGate("ops", "install-locked-dependencies", "npm", INSTALL_ARGS);
    await runGate("ops", "run-ops-regression-tests", "npm", ["test"]);
    await runGate("ops", "validate-compatibility-matrix", "npm", ["run", "check:matrix"]);

    await runGate("data", "install-locked-dependencies", "npm", INSTALL_ARGS);
    await runGate("data", "run-data-policy-tests", "npm", ["test"]);
    await runGate("data", "validate-daily-export-fixture", "npm", ["run", "validate"]);

    for (const key of Object.keys(REPOSITORIES)) {
      const diff = await runGate(key, "reject-generated-source-drift", "git", ["status", "--porcelain", "--untracked-files=no"]);
      if (diff.stdout.trim()) throw new Error(`${key} tests changed tracked source files`);
      evidence.repositories[key].status = "passed";
    }

    evidence.status = "passed-automated-boundaries";
    evidence.finishedAt = new Date().toISOString();
    await rm(workspaceRoot, { recursive: true, force: true });
    evidence.workspaceCleaned = true;
    await writeJsonAtomic(resolve(evidencePath), evidence);
    return evidence;
  } catch (error) {
    for (const repository of Object.values(evidence.repositories)) {
      if (repository.status === "running") repository.status = "failed-or-not-run";
    }
    evidence.status = "failed";
    evidence.finishedAt = new Date().toISOString();
    evidence.error = sanitizeError(error);
    try {
      await rm(workspaceRoot, { recursive: true, force: true });
      evidence.workspaceCleaned = true;
    } catch (cleanupError) {
      evidence.workspaceCleaned = false;
      evidence.cleanupError = sanitizeError(cleanupError);
    }
    await writeJsonAtomic(resolve(evidencePath), evidence);
    throw error;
  }
}

function parseArguments(argv) {
  const [matrixPath, ...rest] = argv;
  if (!matrixPath) throw new Error("usage: run-compatible.mjs <matrix> [--checkout-evidence path] [--evidence path]");
  const options = { matrixPath };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!value) throw new Error(`${flag} requires a value`);
    if (flag === "--checkout-evidence") options.checkoutEvidencePath = value;
    else if (flag === "--evidence") options.evidencePath = value;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCompatibility(parseArguments(process.argv.slice(2))).catch((error) => {
    console.error(sanitizeError(error));
    process.exitCode = 1;
  });
}
