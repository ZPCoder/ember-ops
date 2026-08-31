// The release workflow owns repository credentials. Local development never needs a cross-repo token.
// CI implementations must resolve exact GitHub Release tags from compatibility/versions.json and use
// `git clone --filter=blob:none --branch <tag>`; branches are intentionally rejected as deploy inputs.
import { mkdir, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";

const matrix = JSON.parse(await readFile(process.argv[2], "utf8"));
await mkdir("evidence", { recursive: true });
await writeFile("evidence/resolved-versions.json", `${JSON.stringify(matrix.active, null, 2)}\n`);
console.log("Exact release tuple resolved; authenticated checkout is injected by repository CI.");
