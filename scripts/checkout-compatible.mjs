import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateMatrix } from "./check-matrix.mjs";
import { runProcess, sanitizeError, writeJsonAtomic } from "./lib/process.mjs";

export const REPOSITORIES = Object.freeze({
  protocol: { repository: "ember-protocol", packageName: "@zpcoder/ember-protocol" },
  sdk: { repository: "ember-sdk", packageName: "@zpcoder/ember-sdk" },
  config: { repository: "ember-config", packageName: "@zpcoder/ember-config" },
  client: { repository: "ember-client", packageName: "@zpcoder/ember-client" },
  backendAdmin: { repository: "ember-backend-admin", packageName: "@zpcoder/ember-backend-admin" },
  ops: { repository: "ember-ops", packageName: "@zpcoder/ember-ops" },
  data: { repository: "ember-data", packageName: "@zpcoder/ember-data" },
});

const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function assertReleaseTuple(matrix, section) {
  const matrixErrors = validateMatrix(matrix);
  if (matrixErrors.length > 0) throw new Error(`invalid compatibility matrix: ${matrixErrors.join("; ")}`);
  if (!new Set(["active", "rollback"]).has(section)) throw new Error("section must be active or rollback");
  for (const key of Object.keys(REPOSITORIES)) {
    const version = matrix[section]?.[key];
    if (typeof version !== "string" || !RELEASE_VERSION.test(version)) {
      throw new Error(`${section}.${key} must be an exact release version`);
    }
  }
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

export async function checkoutCompatibility(options) {
  const {
    matrixPath,
    section = "active",
    owner = "ZPCoder",
    workspaceBase = process.env.RUNNER_TEMP ?? ".compat-work",
    evidencePath = "evidence/checkout.json",
    env = process.env,
    commandRunner = runProcess,
  } = options;
  if (!matrixPath) throw new Error("matrixPath is required");
  if (!OWNER.test(owner)) throw new Error("owner is invalid");

  const matrixBytes = await readFile(matrixPath);
  const matrix = JSON.parse(matrixBytes.toString("utf8"));
  const matrixSha256 = createHash("sha256").update(matrixBytes).digest("hex");
  assertReleaseTuple(matrix, section);

  const token = env.GH_TOKEN?.trim();
  const evidence = {
    schemaVersion: 1,
    status: "running",
    section,
    owner,
    matrixPath: basename(matrixPath instanceof URL ? fileURLToPath(matrixPath) : matrixPath),
    matrixSha256,
    packages: matrix[section],
    contracts: matrix.contracts[section],
    startedAt: new Date().toISOString(),
    workspaceRoot: null,
    repositories: {},
  };
  if (!token) {
    evidence.status = "failed";
    evidence.finishedAt = new Date().toISOString();
    evidence.error = "GH_TOKEN is required for private repository checkout";
    await writeJsonAtomic(resolve(evidencePath), evidence);
    throw new Error(evidence.error);
  }

  const base = resolve(workspaceBase);
  await mkdir(base, { recursive: true });
  const workspaceRoot = await mkdtemp(join(base, `ember-compat-${section}-`));
  const workspaceMarker = {
    schemaVersion: 1,
    id: randomUUID(),
    section,
    matrixSha256,
    createdBy: "ember-ops/checkout-compatible",
  };
  await writeFile(
    join(workspaceRoot, ".ember-compat-workspace.json"),
    `${JSON.stringify(workspaceMarker)}\n`,
    { mode: 0o600 },
  );
  evidence.workspaceRoot = workspaceRoot;
  evidence.workspaceMarker = workspaceMarker;

  const run = async (command, args, commandOptions = {}) => {
    const result = await commandRunner(command, args, {
      env,
      ...commandOptions,
    });
    return processResult(result, command, args, commandOptions.cwd);
  };

  try {
    await run("gh", ["auth", "status", "--hostname", "github.com"]);
    for (const [key, definition] of Object.entries(REPOSITORIES)) {
      const version = matrix[section][key];
      const tag = `v${version}`;
      const slug = `${owner}/${definition.repository}`;
      const destination = join(workspaceRoot, definition.repository);
      const credentialHelper = [
        "-c", "credential.helper=",
        "-c", "credential.helper=!gh auth git-credential",
      ];

      await run("git", [
        ...credentialHelper,
        "clone", "--filter=blob:none", "--no-checkout", "--single-branch", "--depth=1",
        `https://github.com/${slug}.git`, destination,
      ]);
      await run("git", [
        ...credentialHelper,
        "fetch", "--force", "--depth=1", "origin",
        `refs/tags/${tag}:refs/tags/${tag}`,
      ], { cwd: destination });
      await run("git", ["checkout", "--detach", "--force", `refs/tags/${tag}`], { cwd: destination });

      const head = (await run("git", ["rev-parse", "HEAD"], { cwd: destination })).stdout.trim();
      const tagCommit = (await run("git", ["rev-parse", `refs/tags/${tag}^{commit}`], { cwd: destination })).stdout.trim();
      if (!/^[a-f0-9]{40}$/.test(head) || head !== tagCommit) {
        throw new Error(`${slug} ${tag} did not resolve to one exact commit`);
      }
      const symbolic = await run("git", ["symbolic-ref", "-q", "HEAD"], {
        cwd: destination,
        allowedExitCodes: [0, 1],
      });
      if (symbolic.exitCode !== 1) throw new Error(`${slug} checkout is attached to a branch`);
      const exactTag = (await run("git", ["describe", "--tags", "--exact-match", "HEAD"], { cwd: destination })).stdout.trim();
      if (exactTag !== tag) throw new Error(`${slug} HEAD is not exactly ${tag}`);
      const trackedChanges = (await run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: destination })).stdout.trim();
      if (trackedChanges) throw new Error(`${slug} checkout is not clean`);

      const packageJson = JSON.parse(await readFile(join(destination, "package.json"), "utf8"));
      if (packageJson.name !== definition.packageName) {
        throw new Error(`${slug} package name ${packageJson.name ?? "<missing>"} does not match ${definition.packageName}`);
      }
      if (packageJson.version !== version) {
        throw new Error(`${slug} package version ${packageJson.version ?? "<missing>"} does not match ${tag}`);
      }
      const rawRemoteUrl = (await run("git", ["remote", "get-url", "origin"], { cwd: destination })).stdout.trim();
      const remoteUrl = rawRemoteUrl
        .split(token).join("[REDACTED]")
        .replace(/^https:\/\/[^/@]+@github\.com\//, "https://github.com/");

      evidence.repositories[key] = {
        repository: slug,
        packageName: definition.packageName,
        version,
        tag,
        sha: head,
        remoteUrl,
        path: destination,
        detached: true,
        clean: true,
      };
    }

    evidence.status = "passed";
    evidence.finishedAt = new Date().toISOString();
    await writeJsonAtomic(resolve(evidencePath), evidence);
    return evidence;
  } catch (error) {
    await rm(workspaceRoot, { recursive: true, force: true });
    evidence.status = "failed";
    evidence.workspaceRoot = null;
    evidence.finishedAt = new Date().toISOString();
    evidence.error = sanitizeError(error, [token]);
    await writeJsonAtomic(resolve(evidencePath), evidence);
    throw error;
  }
}

function parseArguments(argv) {
  const [matrixPath, ...rest] = argv;
  if (!matrixPath) throw new Error("usage: checkout-compatible.mjs <matrix> [--section active|rollback] [--workspace-base path] [--evidence path]");
  const options = { matrixPath };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!value) throw new Error(`${flag} requires a value`);
    if (flag === "--section") options.section = value;
    else if (flag === "--workspace-base") options.workspaceBase = value;
    else if (flag === "--evidence") options.evidencePath = value;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkoutCompatibility(parseArguments(process.argv.slice(2))).catch((error) => {
    console.error(sanitizeError(error, [process.env.GH_TOKEN]));
    process.exitCode = 1;
  });
}
