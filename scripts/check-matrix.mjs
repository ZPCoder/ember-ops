import { readFile } from "node:fs/promises";

export function validateMatrix(matrix) {
  const errors = [];
  const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
  const wireVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  const commitPattern = /^[a-f0-9]{40}$/;
  const externalRepositories = ["protocol", "sdk", "config", "client", "backendAdmin", "data"];
  if (matrix?.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  for (const section of ["active", "rollback"]) {
    for (const name of ["protocol", "sdk", "config", "client", "backendAdmin", "ops", "data"]) {
      if (typeof matrix?.[section]?.[name] !== "string" || matrix[section][name].length === 0) {
        errors.push(`${section}.${name} is required`);
      } else if (!semverPattern.test(matrix[section][name])) {
        errors.push(`${section}.${name} must be an exact SemVer package version`);
      }
    }
  }
  for (const section of ["active", "rollback"]) {
    for (const name of externalRepositories) {
      if (!commitPattern.test(matrix?.expectedCommits?.[section]?.[name] ?? "")) {
        errors.push(`expectedCommits.${section}.${name} must be an immutable 40-character commit SHA`);
      }
    }
    if (matrix?.expectedCommits?.[section]?.ops !== undefined) {
      errors.push(`expectedCommits.${section}.ops must be omitted; Ops is the current workflow checkout`);
    }
    const contract = matrix?.contracts?.[section];
    if (typeof contract?.protocolVersion !== "string" || !wireVersionPattern.test(contract.protocolVersion)) {
      errors.push(`contracts.${section}.protocolVersion must be a canonical major.minor wire version`);
    }
    const manifest = contract?.configManifest;
    if (typeof manifest?.version !== "string" || !semverPattern.test(manifest.version)) {
      errors.push(`contracts.${section}.configManifest.version must be an exact SemVer config version`);
    }
    if (typeof manifest?.minimumClientVersion !== "string" || !semverPattern.test(manifest.minimumClientVersion)) {
      errors.push(`contracts.${section}.configManifest.minimumClientVersion must be an exact SemVer client version`);
    }
    if (!/^[a-f0-9]{64}$/.test(manifest?.sha256 ?? "")) {
      errors.push(`contracts.${section}.configManifest.sha256 must be a lowercase SHA-256 digest`);
    }
  }
  const activeContract = matrix?.contracts?.active;
  const protocolMajor = Number.parseInt(activeContract?.protocolVersion?.split(".")[0] ?? "", 10);
  if (!matrix?.constraints?.supportedProtocolMajors?.includes(protocolMajor)) {
    errors.push("active protocol major is not supported");
  }
  if (activeContract?.configManifest?.minimumClientVersion !== matrix?.constraints?.minimumClientVersion) {
    errors.push("config and integration minimum client versions must match");
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
    console.log(`compatible: protocol package ${matrix.active.protocol}, wire ${matrix.contracts.active.protocolVersion}, client ${matrix.active.client}`);
  }
}
