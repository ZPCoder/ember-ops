import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkoutCompatibility, REPOSITORIES } from "../scripts/checkout-compatible.mjs";

function success(command, args, options, stdout = "", exitCode = 0) {
  return { command, args, cwd: options.cwd, stdout, stderr: "", exitCode, durationMs: 1 };
}

function fakeCheckoutRunner(commands, failRepository) {
  return async (command, args, options) => {
    commands.push({ command, args: [...args], cwd: options.cwd });
    if (command === "gh" && args[0] === "auth") return success(command, args, options);
    if (command === "git" && args.includes("clone")) {
      const repository = args.at(-2).split("/").at(-1).replace(/\.git$/, "");
      const destination = args.at(-1);
      const definition = Object.values(REPOSITORIES).find((candidate) => candidate.repository === repository);
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "package.json"), JSON.stringify({ name: definition.packageName, version: "0.1.0" }));
      return success(command, args, options);
    }
    if (command !== "git") throw new Error(`unexpected command ${command}`);
    const operation = args.find((value) => new Set(["fetch", "checkout", "rev-parse", "symbolic-ref", "describe", "status", "remote"]).has(value));
    const repository = options.cwd?.split("/").at(-1);
    if (operation === "fetch" && repository === failRepository) throw new Error(`simulated private fetch failure for ${repository}`);
    const index = Object.values(REPOSITORIES).findIndex((definition) => definition.repository === repository) + 1;
    const sha = createHash("sha1").update(`${repository}-${index}`).digest("hex");
    if (operation === "rev-parse") return success(command, args, options, `${sha}\n`);
    if (operation === "symbolic-ref") return success(command, args, options, "", 1);
    if (operation === "describe") return success(command, args, options, "v0.1.0\n");
    if (operation === "status") return success(command, args, options, "");
    if (operation === "remote") return success(command, args, options, `https://github.com/ZPCoder/${repository}.git\n`);
    return success(command, args, options);
  };
}

test("checks out every private repository at an authenticated exact detached tag", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "ember-checkout-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const commands = [];
  const evidencePath = join(temporary, "evidence.json");
  const result = await checkoutCompatibility({
    matrixPath: new URL("../compatibility/versions.json", import.meta.url),
    workspaceBase: join(temporary, "workspaces"),
    evidencePath,
    env: { GH_TOKEN: "test-private-token" },
    commandRunner: fakeCheckoutRunner(commands),
  });

  assert.equal(result.status, "passed");
  assert.equal(Object.keys(result.repositories).length, 7);
  assert.ok(Object.values(result.repositories).every((repository) => repository.detached && repository.clean));
  const fetches = commands.filter(({ command, args }) => command === "git" && args.includes("fetch"));
  const clones = commands.filter(({ command, args }) => command === "git" && args.includes("clone"));
  assert.equal(clones.length, 7);
  assert.equal(fetches.length, 7);
  for (const operation of [...clones, ...fetches]) {
    assert.deepEqual(operation.args.slice(0, 4), [
      "-c", "credential.helper=",
      "-c", "credential.helper=!gh auth git-credential",
    ]);
  }
  for (const fetch of fetches) {
    assert.match(fetch.args.at(-1), /^refs\/tags\/v0\.1\.0:refs\/tags\/v0\.1\.0$/);
  }
  const persisted = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.ok(Object.values(persisted.repositories).every((repository) => /^[a-f0-9]{40}$/.test(repository.sha)));
});

test("missing token fails closed before attempting a clone", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "ember-checkout-token-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  let called = false;
  const evidencePath = join(temporary, "evidence.json");
  await assert.rejects(checkoutCompatibility({
    matrixPath: new URL("../compatibility/versions.json", import.meta.url),
    workspaceBase: join(temporary, "workspaces"),
    evidencePath,
    env: {},
    commandRunner: async () => {
      called = true;
    },
  }), /GH_TOKEN is required/);
  assert.equal(called, false);
  assert.equal(JSON.parse(await readFile(evidencePath, "utf8")).status, "failed");
});

test("failed private tag fetch removes the isolated workspace", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "ember-checkout-cleanup-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const workspaceBase = join(temporary, "workspaces");
  const evidencePath = join(temporary, "evidence.json");
  await assert.rejects(checkoutCompatibility({
    matrixPath: new URL("../compatibility/versions.json", import.meta.url),
    workspaceBase,
    evidencePath,
    env: { GH_TOKEN: "test-private-token" },
    commandRunner: fakeCheckoutRunner([], "ember-sdk"),
  }), /simulated private fetch failure/);
  assert.deepEqual(await readdir(workspaceBase), []);
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.workspaceRoot, null);
});
