import { mkdir, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";

const matrix = JSON.parse(await readFile(process.argv[2], "utf8"));
const gates = [
  "protocol-generate-and-compat",
  "sdk-235-rules-and-fixed-replays",
  "config-hash-and-1000-card-catalog",
  "cocos-static-and-editor-build",
  "react-production-build",
  "backend-empty-and-legacy-migrations",
  "cross-client-pvp-e2e",
];
await mkdir("evidence", { recursive: true });
await writeFile("evidence/gates.json", `${JSON.stringify({ matrix: matrix.active, required: gates }, null, 2)}\n`);
console.log(gates.join("\n"));
