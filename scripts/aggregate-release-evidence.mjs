import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateK6Summary } from "./verify-k6-summary.mjs";

async function files(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

export async function aggregateReleaseEvidence(root, sourceSha) {
  const paths = await files(resolve(root));
  const byName = new Map(paths.map((path) => [basename(path), path]));
  const gates = JSON.parse(await readFile(byName.get("gates.json") ?? "", "utf8"));
  const editor = JSON.parse(await readFile(byName.get("cocos-editor.json") ?? "", "utf8"));
  if (gates.status !== "passed-automated-boundaries") throw new Error("automated compatibility evidence is not passed");
  if (editor.status !== "passed-editor-boundary") throw new Error("Cocos editor evidence is not passed");
  const probes = ["cloudflare-egress", "cn-mainland-east", "cn-mainland-south"];
  const loads = [];
  const targetPasses = {};
  for (const targetId of ["cloudflare", "mainland-container"]) {
    targetPasses[targetId] = true;
    for (const probeId of probes) {
      const path = byName.get(`k6-${targetId}-${probeId}.json`);
      if (!path) {
        targetPasses[targetId] = false;
        continue;
      }
      const summary = JSON.parse(await readFile(path, "utf8"));
      const errors = validateK6Summary(summary, { targetId, probeId, sourceSha });
      if (errors.length > 0) targetPasses[targetId] = false;
      loads.push({ targetId, probeId, status: errors.length === 0 ? "passed" : "failed", runId: summary.runId, generatedAt: summary.generatedAt });
    }
  }
  const selectedHosting = targetPasses.cloudflare ? "cloudflare" : targetPasses["mainland-container"] ? "mainland-container" : null;
  if (!selectedHosting) throw new Error("neither Cloudflare nor the mainland container passed every required probe");
  return { schemaVersion: 1, status: "release-required-passed", sourceSha, selectedHosting, targetPasses, loads };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, sourceSha, output] = process.argv.slice(2);
  if (!root || !/^[a-f0-9]{40}$/.test(sourceSha ?? "") || !output) {
    throw new Error("usage: aggregate-release-evidence.mjs <artifact-root> <source-sha> <output>");
  }
  const evidence = await aggregateReleaseEvidence(root, sourceSha);
  await writeFile(resolve(output), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(`release aggregate passed for ${sourceSha}`);
}
