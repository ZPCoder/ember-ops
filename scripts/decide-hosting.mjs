import { readFile } from "node:fs/promises";

export function decideHosting(results) {
  const probes = Array.isArray(results.probes) ? results.probes : [];
  const mainlandProbes = probes.filter((probe) => probe.region === "CN");
  const allMainlandPass = mainlandProbes.length > 0 && mainlandProbes.every((probe) =>
    probe.statePropagationP95Ms <= 800
    && probe.reconnectP95Ms <= 3_000
    && probe.errorRate < 0.005
    && probe.duplicateSettlements === 0
    && probe.lostCommands === 0);
  return allMainlandPass ? "cloudflare" : "container-mainland";
}

if (process.argv[1]?.endsWith("decide-hosting.mjs")) {
  const path = process.argv[2] ?? "load/results.json";
  const results = JSON.parse(await readFile(path, "utf8"));
  console.log(decideHosting(results));
}
