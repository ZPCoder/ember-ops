import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTERNAL_REPOSITORY_KEYS, REPOSITORIES } from "./checkout-compatible.mjs";
import { validateMatrix } from "./check-matrix.mjs";
import { commandEvidence, runProcess, sanitizeError, writeJsonAtomic } from "./lib/process.mjs";

const INSTALL_ARGS = ["ci", "--ignore-scripts", "--no-audit", "--no-fund"];
const SECRET_ENVIRONMENT_NAMES = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
  "EMBER_REPOSITORY_READ_TOKEN",
]);
const VERIFY_INSTALLED_SCRIPT = fileURLToPath(new URL("./verify-installed-compatibility.mjs", import.meta.url));
const VERIFY_REACT_REPLAY_SCRIPT = fileURLToPath(new URL("./verify-react-replay-parity.mjs", import.meta.url));
const FIXED_REPLAY_FIXTURE = fileURLToPath(new URL("../compatibility/fixtures/fixed-replay.json", import.meta.url));

export function environmentWithoutCredentials(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !SECRET_ENVIRONMENT_NAMES.has(name)),
  );
}

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

function tarballName(packageName, version) {
  return `${packageName.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
}

function parseJsonOutput(result, label) {
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  try {
    return JSON.parse(lines.at(-1));
  } catch {
    throw new Error(`${label} did not emit JSON evidence`);
  }
}

async function guardedWorkspace(checkout) {
  if (typeof checkout?.workspaceRoot !== "string" || typeof checkout?.workspaceBase !== "string") return null;
  const workspaceRoot = resolve(checkout.workspaceRoot);
  const workspaceBase = resolve(checkout.workspaceBase);
  if (dirname(workspaceRoot) !== workspaceBase
    || !basename(workspaceRoot).startsWith(`ember-compat-${checkout.section}-`)) return null;
  try {
    const marker = JSON.parse(await readFile(join(workspaceRoot, ".ember-compat-workspace.json"), "utf8"));
    if (marker.createdBy !== "ember-ops/checkout-compatible"
      || marker.schemaVersion !== 1
      || marker.section !== checkout.section) return null;
    return { workspaceRoot, workspaceBase, marker };
  } catch {
    return null;
  }
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

  let cleanup = null;
  let failure = null;
  const evidence = {
    schemaVersion: 1,
    status: "running",
    releaseReady: false,
    startedAt: new Date().toISOString(),
    repositories: {},
    requiredExternalGates: [
      {
        id: "cocos-creator-3.8.8-web-build",
        status: "required-not-run-here",
        workflowJob: "creator-editor-required",
        runnerLabels: ["self-hosted", "ephemeral", "cocos-creator-3.8.8"],
      },
      {
        id: "pvp-500-vu-multi-probe",
        status: "required-not-run-here",
        workflowJob: "pvp-load-required",
        probes: ["cloudflare-egress", "cn-mainland-east", "cn-mainland-south"],
      },
    ],
  };

  try {
    const matrixBytes = await readFile(matrixPath);
    const matrix = JSON.parse(matrixBytes.toString("utf8"));
    const errors = validateMatrix(matrix);
    if (errors.length > 0) throw new Error(`invalid compatibility matrix: ${errors.join("; ")}`);

    const checkout = JSON.parse(await readFile(checkoutEvidencePath, "utf8"));
    cleanup = await guardedWorkspace(checkout);
    if (!cleanup) throw new Error("checkout workspace is not a guarded isolated workspace");
    if (checkout.status !== "passed") throw new Error("checkout evidence is not passed");
    if (!new Set(["active", "rollback"]).has(checkout.section)) throw new Error("checkout evidence section is invalid");
    const section = checkout.section;
    const matrixSha256 = createHash("sha256").update(matrixBytes).digest("hex");
    if (checkout.matrixSha256 !== matrixSha256) throw new Error("checkout evidence was produced from a different matrix file");
    if (!sameJson(checkout.packages, matrix[section])) throw new Error("checkout package tuple differs from the matrix");
    if (!sameJson(checkout.contracts, matrix.contracts[section])) throw new Error("checkout contract tuple differs from the matrix");
    if (!sameJson(checkout.expectedCommits, matrix.expectedCommits[section])) throw new Error("checkout commit tuple differs from the matrix");
    if (!sameJson(cleanup.marker, checkout.workspaceMarker)
      || cleanup.marker.matrixSha256 !== matrixSha256) {
      throw new Error("checkout workspace marker does not match the evidence");
    }

    Object.assign(evidence, {
      section,
      matrixSha256,
      packages: matrix[section],
      contracts: matrix.contracts[section],
      expectedCommits: matrix.expectedCommits[section],
      checkoutEvidencePath: resolve(checkoutEvidencePath),
    });

    const gateEnv = environmentWithoutCredentials(env);
    const runGate = async (key, name, command, args) => {
      const repository = evidence.repositories[key];
      try {
        const raw = await commandRunner(command, args, { cwd: repository.path, env: gateEnv });
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

    for (const [key, definition] of Object.entries(REPOSITORIES)) {
      const checkedOut = checkout.repositories?.[key];
      if (!checkedOut) throw new Error(`checkout evidence is missing ${key}`);
      const repositoryPath = key === "ops"
        ? resolve(checkedOut.path)
        : assertInsideWorkspace(cleanup.workspaceRoot, checkedOut.path);
      const version = matrix[section][key];
      const expectedSha = key === "ops" ? checkedOut.expectedSha : matrix.expectedCommits[section][key];
      if (!/^[a-f0-9]{40}$/.test(expectedSha) || checkedOut.sha !== expectedSha) {
        throw new Error(`${key} checkout does not match its immutable source SHA`);
      }
      const packageJson = JSON.parse(await readFile(join(repositoryPath, "package.json"), "utf8"));
      if (packageJson.name !== definition.packageName || packageJson.version !== version) {
        throw new Error(`${key} package identity changed after checkout`);
      }
      evidence.repositories[key] = {
        repository: checkedOut.repository,
        packageName: definition.packageName,
        version,
        tag: checkedOut.tag,
        sha: expectedSha,
        path: repositoryPath,
        source: checkedOut.source ?? "pinned-release-tag",
        status: "running",
        gates: [],
      };
      const head = (await runGate(key, "verify-checkout-sha", "git", ["rev-parse", "HEAD"])).stdout.trim();
      if (head !== expectedSha) throw new Error(`${key} HEAD drifted after checkout`);
      if (key !== "ops") {
        const exactTag = (await runGate(key, "verify-exact-tag", "git", ["describe", "--tags", "--exact-match", "HEAD"])).stdout.trim();
        if (exactTag !== `v${version}`) throw new Error(`${key} is no longer at exact release tag v${version}`);
      }
      addAssertion(key, "package-version-matches-coordinate", { expectedVersion: version, actualVersion: packageJson.version });
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

    const packagesDirectory = join(cleanup.workspaceRoot, ".local-packages");
    await mkdir(packagesDirectory, { recursive: true });
    const tarballs = [];
    for (const key of ["protocol", "config", "sdk"]) {
      await runGate(key, "pack-local-integration-artifact", "npm", [
        "pack", "--ignore-scripts", "--pack-destination", packagesDirectory,
      ]);
      const tarball = join(packagesDirectory, tarballName(REPOSITORIES[key].packageName, matrix[section][key]));
      const artifact = await stat(tarball);
      if (!artifact.isFile() || artifact.size === 0) throw new Error(`${key} local integration tarball was not created`);
      const sha256 = createHash("sha256").update(await readFile(tarball)).digest("hex");
      tarballs.push(tarball);
      addAssertion(key, "local-integration-tarball", { path: tarball, size: artifact.size, sha256 });
    }
    const localInstallArgs = [
      "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
      "--no-save", "--package-lock=false", ...tarballs,
    ];

    await runGate("client", "install-locked-dependencies", "npm", INSTALL_ARGS);
    await runGate("client", "install-local-protocol-sdk-config", "npm", localInstallArgs);
    await runGate("client", "run-client-boundary-tests", "npm", ["test"]);
    await runGate("client", "typecheck-cocos-client", "npm", ["run", "typecheck:ci"]);
    await runGate("client", "install-react-fallback-locked-dependencies", "npm", [
      "--prefix", "reference-react/legacy", "ci", "--ignore-scripts", "--no-audit", "--no-fund",
    ]);
    await runGate("client", "test-react-fallback", "npm", ["run", "test:react-reference"]);
    await runGate("client", "build-react-fallback", "npm", ["run", "build:react-reference"]);
    const clientReplay = await runGate("client", "verify-local-packages-and-fixed-replay", "node", [
      VERIFY_INSTALLED_SCRIPT, resolve(matrixPath), section, FIXED_REPLAY_FIXTURE,
    ]);
    const clientReplayEvidence = parseJsonOutput(clientReplay, "client fixed replay");
    addAssertion("client", "fixed-authoritative-replay-digest", clientReplayEvidence);
    const reactReplay = await runGate("client", "verify-react-fixed-replay-parity", "node", [
      "--experimental-strip-types", VERIFY_REACT_REPLAY_SCRIPT,
      evidence.repositories.client.path, FIXED_REPLAY_FIXTURE,
    ]);
    const reactReplayEvidence = parseJsonOutput(reactReplay, "React fixed replay");
    if (reactReplayEvidence.stateDigest !== clientReplayEvidence.stateDigest) {
      throw new Error("React frozen rules and installed SDK fixed replay digests differ");
    }
    addAssertion("client", "react-sdk-replay-parity", reactReplayEvidence);
    addAssertion("client", "cocos-editor-build-delegated", { status: "required-external", workflowJob: "creator-editor-required" });

    await runGate("backendAdmin", "install-locked-dependencies", "npm", INSTALL_ARGS);
    await runGate("backendAdmin", "install-local-protocol-sdk-config", "npm", localInstallArgs);
    await runGate("backendAdmin", "typecheck-and-test-backend", "npm", ["run", "check"]);
    const backendReplay = await runGate("backendAdmin", "verify-local-packages-and-fixed-replay", "node", [
      VERIFY_INSTALLED_SCRIPT, resolve(matrixPath), section, FIXED_REPLAY_FIXTURE,
    ]);
    const backendReplayEvidence = parseJsonOutput(backendReplay, "backend fixed replay");
    if (backendReplayEvidence.stateDigest !== clientReplayEvidence.stateDigest) {
      throw new Error("client and backend fixed replay digests differ");
    }
    addAssertion("backendAdmin", "fixed-authoritative-replay-digest", backendReplayEvidence);
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
  } catch (error) {
    failure = error;
    for (const repository of Object.values(evidence.repositories)) {
      if (repository.status === "running") repository.status = "failed-or-not-run";
    }
    evidence.status = "failed";
    evidence.finishedAt = new Date().toISOString();
    evidence.error = sanitizeError(error);
  } finally {
    if (cleanup) {
      try {
        await rm(cleanup.workspaceRoot, { recursive: true, force: true });
        evidence.workspaceCleaned = true;
      } catch (cleanupError) {
        evidence.workspaceCleaned = false;
        evidence.cleanupError = sanitizeError(cleanupError);
        failure ??= cleanupError;
        evidence.status = "failed";
      }
    } else {
      evidence.workspaceCleaned = null;
    }
    await writeJsonAtomic(resolve(evidencePath), evidence);
  }

  if (failure) throw failure;
  return evidence;
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
