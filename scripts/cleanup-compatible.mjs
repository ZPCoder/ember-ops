import { readFile, readdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE_NAME = /^ember-compat-(?:active|rollback)-[A-Za-z0-9_-]+$/;

export async function cleanupCompatibleWorkspaces(workspaceBase) {
  if (typeof workspaceBase !== "string" || workspaceBase.trim().length === 0) {
    throw new Error("workspace base is required");
  }
  const base = resolve(workspaceBase);
  if (base === "/" || basename(base).length === 0) throw new Error("refusing broad cleanup base");
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !WORKSPACE_NAME.test(entry.name)) continue;
    const candidate = join(base, entry.name);
    let marker;
    try {
      marker = JSON.parse(await readFile(join(candidate, ".ember-compat-workspace.json"), "utf8"));
    } catch {
      continue;
    }
    if (marker?.schemaVersion !== 1
      || marker?.createdBy !== "ember-ops/checkout-compatible"
      || !new Set(["active", "rollback"]).has(marker?.section)
      || !entry.name.startsWith(`ember-compat-${marker.section}-`)) continue;
    await rm(candidate, { recursive: true, force: true });
    removed.push(candidate);
  }
  return removed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = process.argv[2];
  cleanupCompatibleWorkspaces(base).then((removed) => {
    console.log(JSON.stringify({ status: "passed", removed }));
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
