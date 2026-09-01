import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCocosEditorGate } from "../scripts/run-cocos-editor-gate.mjs";

test("Cocos editor gate fails closed without a configured licensed executable", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "ember-editor-gate-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const workspaceBase = join(temporary, "workspaces");
  await mkdir(workspaceBase, { recursive: true });
  const workspaceRoot = await mkdtemp(join(workspaceBase, "ember-compat-active-"));
  const clientPath = join(workspaceRoot, "ember-client");
  await mkdir(clientPath);
  const checkoutPath = join(temporary, "checkout.json");
  const evidencePath = join(temporary, "editor.json");
  const workspaceMarker = {
    schemaVersion: 1,
    id: "fixture-workspace",
    section: "active",
    matrixSha256: "b".repeat(64),
    createdBy: "ember-ops/checkout-compatible",
  };
  await writeFile(join(workspaceRoot, ".ember-compat-workspace.json"), JSON.stringify(workspaceMarker));
  await writeFile(checkoutPath, JSON.stringify({
    status: "passed",
    section: "active",
    workspaceRoot,
    workspaceBase,
    workspaceMarker,
    repositories: {
      client: { repository: "ZPCoder/ember-client", tag: "v0.1.0", sha: "a".repeat(40), expectedSha: "a".repeat(40), path: clientPath },
    },
  }));
  await assert.rejects(runCocosEditorGate({
    checkoutEvidencePath: checkoutPath,
    evidencePath,
    env: {},
    commandRunner: async () => {
      throw new Error("runner must not be called without COCOS_CREATOR_CLI");
    },
  }), /COCOS_CREATOR_CLI must be configured/);
  await assert.rejects(access(workspaceRoot));
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.aggregateRequired, true);
  assert.equal(evidence.workspaceCleaned, true);
});

test("workflow limits secret gates to trusted main and preflights self-hosted jobs", async () => {
  const workflow = await readFile(new URL("../.github/workflows/compatibility.yml", import.meta.url), "utf8");
  assert.match(workflow, /branches: \[main\]/);
  assert.doesNotMatch(workflow, /workflow_dispatch:|tags:/);
  assert.match(workflow, /automated-compatibility-no-editor:/);
  assert.match(workflow, /creator-editor-required:/);
  assert.match(workflow, /runs-on: \[self-hosted, ephemeral, cocos-creator-3\.8\.8\]/);
  assert.match(workflow, /release-preflight:/);
  assert.match(workflow, /load-environment-preflight:/);
  assert.match(workflow, /max-parallel: 1/);
  assert.match(workflow, /pvp-load-required:/);
  assert.match(workflow, /release-required:/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /^  pull_request:/m);
  assert.match(workflow, /run-compatible\.mjs/);
  assert.match(workflow, /run-cocos-editor-gate\.mjs/);
  assert.match(workflow, /preprovision-load-rooms\.mjs/);
  assert.match(workflow, /github\.run_attempt/);
  assert.match(workflow, /EMBER_LOAD_PREPROVISION_TOKEN/);
  assert.doesNotMatch(workflow, /vars\.EMBER_LOAD_ROOM_FIXTURE/);
  const prWorkflow = await readFile(new URL("../.github/workflows/ops-ci.yml", import.meta.url), "utf8");
  assert.match(prWorkflow, /pull_request:/);
  assert.doesNotMatch(prWorkflow, /EMBER_REPOSITORY_READ_TOKEN/);
});
