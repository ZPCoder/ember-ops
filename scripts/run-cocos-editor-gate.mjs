import { access, constants, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commandEvidence, runProcess, sanitizeError, writeJsonAtomic } from "./lib/process.mjs";

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

export async function runCocosEditorGate(options) {
  const {
    checkoutEvidencePath = "evidence/checkout-editor.json",
    evidencePath = "evidence/cocos-editor.json",
    env = process.env,
    commandRunner = runProcess,
  } = options;
  const checkout = JSON.parse(await readFile(checkoutEvidencePath, "utf8"));
  if (checkout.status !== "passed") throw new Error("checkout evidence is not passed");
  const client = checkout.repositories?.client;
  const workspaceRoot = resolve(checkout.workspaceRoot ?? "");
  if (!basename(workspaceRoot).startsWith(`ember-compat-${checkout.section}-`)) {
    throw new Error("checkout workspace does not have the guarded compatibility prefix");
  }
  const workspaceMarker = JSON.parse(await readFile(join(workspaceRoot, ".ember-compat-workspace.json"), "utf8"));
  if (JSON.stringify(workspaceMarker) !== JSON.stringify(checkout.workspaceMarker)
    || workspaceMarker.createdBy !== "ember-ops/checkout-compatible") {
    throw new Error("checkout workspace marker is missing or does not match the evidence");
  }
  if (!client || !inside(workspaceRoot, client.path)) {
    throw new Error("client checkout is outside the isolated workspace");
  }

  const executable = env.COCOS_CREATOR_CLI?.trim();
  const evidence = {
    schemaVersion: 1,
    status: "running",
    releaseReady: false,
    requiredEditorVersion: "3.8.8",
    client: { repository: client.repository, tag: client.tag, sha: client.sha },
    startedAt: new Date().toISOString(),
    gates: [],
  };

  const run = async (name, command, args, cwd = client.path) => {
    try {
      const result = await commandRunner(command, args, { cwd, env });
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

  try {
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

    evidence.status = "passed";
    evidence.releaseReady = true;
    evidence.finishedAt = new Date().toISOString();
    evidence.output = { path: outputPath, fileCount, entrypoint: "index.html" };
    await rm(workspaceRoot, { recursive: true, force: true });
    evidence.workspaceCleaned = true;
    await writeJsonAtomic(resolve(evidencePath), evidence);
    return evidence;
  } catch (error) {
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
