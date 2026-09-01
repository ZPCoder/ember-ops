import { access, constants, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commandEvidence, runProcess, sanitizeError, writeJsonAtomic } from "./lib/process.mjs";

const SECRET_ENVIRONMENT_NAMES = new Set([
  "GH_TOKEN", "GITHUB_TOKEN", "NODE_AUTH_TOKEN", "NPM_TOKEN", "EMBER_REPOSITORY_READ_TOKEN",
]);

function inside(root, candidate) {
  const child = relative(resolve(root), resolve(candidate));
  return child.length > 0 && !child.startsWith("..") && !isAbsolute(child);
}

async function countFiles(path) {
  let count = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) count += await countFiles(child);
    else if (entry.isFile()) count += 1;
  }
  return count;
}

function safeEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !SECRET_ENVIRONMENT_NAMES.has(key)));
}

export async function runCocosEditorGate(options) {
  const {
    checkoutEvidencePath = "evidence/checkout-editor.json",
    evidencePath = "evidence/cocos-editor.json",
    env = process.env,
    commandRunner = runProcess,
  } = options;
  const evidence = {
    schemaVersion: 1,
    status: "running",
    aggregateRequired: true,
    requiredEditorVersion: "3.8.8",
    startedAt: new Date().toISOString(),
    gates: [],
  };
  let workspaceRoot = null;
  let cleanupAuthorized = false;
  let failure = null;

  try {
    const checkout = JSON.parse(await readFile(checkoutEvidencePath, "utf8"));
    if (typeof checkout.workspaceRoot !== "string" || typeof checkout.workspaceBase !== "string") {
      throw new Error("checkout evidence has no guarded workspace paths");
    }
    workspaceRoot = resolve(checkout.workspaceRoot);
    const workspaceBase = resolve(checkout.workspaceBase);
    if (dirname(workspaceRoot) !== workspaceBase
      || !basename(workspaceRoot).startsWith(`ember-compat-${checkout.section}-`)) {
      throw new Error("checkout workspace does not have the guarded compatibility prefix");
    }
    const workspaceMarker = JSON.parse(await readFile(join(workspaceRoot, ".ember-compat-workspace.json"), "utf8"));
    if (workspaceMarker.createdBy === "ember-ops/checkout-compatible" && workspaceMarker.schemaVersion === 1) {
      cleanupAuthorized = true;
    }
    if (checkout.status !== "passed") throw new Error("checkout evidence is not passed");
    if (JSON.stringify(workspaceMarker) !== JSON.stringify(checkout.workspaceMarker)
      || workspaceMarker.createdBy !== "ember-ops/checkout-compatible") {
      throw new Error("checkout workspace marker is missing or does not match the evidence");
    }
    const client = checkout.repositories?.client;
    if (!client || !inside(workspaceRoot, client.path)) {
      throw new Error("client checkout is outside the isolated workspace");
    }
    if (!/^[a-f0-9]{40}$/.test(client.sha) || client.expectedSha !== client.sha) {
      throw new Error("client checkout is not bound to its registered commit");
    }
    evidence.client = { repository: client.repository, tag: client.tag, sha: client.sha };

    const executable = env.COCOS_CREATOR_CLI?.trim();
    const gateEnv = safeEnvironment(env);
    const run = async (name, command, args, cwd = client.path) => {
      try {
        const result = await commandRunner(command, args, { cwd, env: gateEnv });
        const normalized = {
          command,
          args,
          cwd,
          startedAt: result.startedAt ?? new Date().toISOString(),
          durationMs: result.durationMs ?? 0,
          exitCode: result.exitCode ?? 0,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        };
        evidence.gates.push(commandEvidence(normalized, name));
        return normalized;
      } catch (error) {
        const result = error?.result ?? { command, args, cwd, exitCode: 1, stdout: "", stderr: sanitizeError(error) };
        evidence.gates.push(commandEvidence(result, name));
        throw error;
      }
    };

    if (!executable) throw new Error("COCOS_CREATOR_CLI must be configured on the self-hosted runner");
    if (!isAbsolute(executable)) throw new Error("COCOS_CREATOR_CLI must be an absolute executable path");
    await access(executable, constants.X_OK);
    const version = await run("verify-cocos-creator-version", executable, ["--version"]);
    if (!/\b3\.8\.8\b/.test(`${version.stdout}\n${version.stderr}`)) {
      throw new Error("Cocos Creator executable is not version 3.8.8");
    }

    await run("install-locked-client-dependencies", "npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
    await run("run-client-tests", "npm", ["test"]);
    await run("typecheck-client", "npm", ["run", "typecheck:ci"]);

    const outputPath = resolve(client.path, env.COCOS_BUILD_OUTPUT?.trim() || "build/ember-web");
    if (!inside(client.path, outputPath)) throw new Error("COCOS_BUILD_OUTPUT must remain inside the client checkout");
    await rm(outputPath, { recursive: true, force: true });
    await run("build-cocos-web-desktop", executable, [
      "--project", client.path,
      "--build", "platform=web-desktop;debug=false;name=ember-web;md5Cache=true",
    ]);
    const output = await stat(outputPath);
    if (!output.isDirectory()) throw new Error("Cocos build output is not a directory");
    const index = await stat(join(outputPath, "index.html"));
    if (!index.isFile()) throw new Error("Cocos Web build did not emit index.html");
    const fileCount = await countFiles(outputPath);
    if (fileCount < 2) throw new Error("Cocos Web build output is incomplete");

    const postBuildHead = (await run("verify-client-sha-after-editor-build", "git", ["rev-parse", "HEAD"])).stdout.trim();
    if (postBuildHead !== client.sha) throw new Error("client HEAD changed during the editor build");
    const postBuildTag = (await run("verify-client-tag-after-editor-build", "git", ["describe", "--tags", "--exact-match", "HEAD"])).stdout.trim();
    if (postBuildTag !== client.tag) throw new Error("client release tag changed during the editor build");
    const trackedChanges = (await run("reject-editor-generated-source-drift", "git", [
      "status", "--porcelain", "--untracked-files=no",
    ])).stdout.trim();
    if (trackedChanges) throw new Error("Cocos editor build changed tracked client source");

    evidence.status = "passed-editor-boundary";
    evidence.finishedAt = new Date().toISOString();
    evidence.output = { path: outputPath, fileCount, entrypoint: "index.html" };
  } catch (error) {
    failure = error;
    evidence.status = "failed";
    evidence.finishedAt = new Date().toISOString();
    evidence.error = sanitizeError(error);
  } finally {
    if (cleanupAuthorized && workspaceRoot) {
      try {
        await rm(workspaceRoot, { recursive: true, force: true });
        evidence.workspaceCleaned = true;
      } catch (cleanupError) {
        evidence.workspaceCleaned = false;
        evidence.cleanupError = sanitizeError(cleanupError);
        evidence.status = "failed";
        failure ??= cleanupError;
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
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`${flag} requires a value`);
    if (flag === "--checkout-evidence") options.checkoutEvidencePath = value;
    else if (flag === "--evidence") options.evidencePath = value;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCocosEditorGate(parseArguments(process.argv.slice(2))).catch((error) => {
    console.error(sanitizeError(error));
    process.exitCode = 1;
  });
}
