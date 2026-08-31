import { readFile } from "node:fs/promises";

export function validateMatrix(matrix) {
  const errors = [];
  if (matrix?.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  for (const section of ["active", "rollback"]) {
    for (const name of ["protocol", "sdk", "config", "client", "backendAdmin", "data"]) {
      if (typeof matrix?.[section]?.[name] !== "string" || matrix[section][name].length === 0) {
        errors.push(`${section}.${name} is required`);
      }
    }
  }
  const protocolMajor = Number.parseInt(matrix?.active?.protocol?.split(".")[0] ?? "", 10);
  if (!matrix?.constraints?.supportedProtocolMajors?.includes(protocolMajor)) {
    errors.push("active protocol major is not supported");
  }
  if ((matrix?.constraints?.serverRetainsMinorVersions ?? 0) < 2) {
    errors.push("server must retain current and previous protocol minor versions");
  }
  return errors;
}

if (process.argv[1]?.endsWith("check-matrix.mjs")) {
  const path = process.argv[2];
  const matrix = JSON.parse(await readFile(path, "utf8"));
  const errors = validateMatrix(matrix);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`compatible: protocol ${matrix.active.protocol}, client ${matrix.active.client}`);
  }
}
