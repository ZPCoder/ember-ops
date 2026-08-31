import { spawn } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

function appendLimited(current, chunk) {
  const next = `${current}${chunk}`;
  return next.length <= MAX_CAPTURE_BYTES ? next : next.slice(-MAX_CAPTURE_BYTES);
}

export async function runProcess(command, args, options = {}) {
  const {
    cwd,
    env = process.env,
    allowedExitCodes = [0],
  } = options;
  const startedAt = new Date().toISOString();
  const started = Date.now();

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk.toString());
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk.toString());
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      const exitCode = code ?? 1;
      const result = {
        command,
        args: [...args],
        cwd,
        startedAt,
        durationMs: Date.now() - started,
        exitCode,
        signal,
        stdout,
        stderr,
      };
      if (!allowedExitCodes.includes(exitCode)) {
        const error = new Error(`${command} exited with ${exitCode}${signal ? ` (${signal})` : ""}`);
        error.result = result;
        reject(error);
        return;
      }
      resolve(result);
    });
  });
}

export function outputTail(value, maxLength = 16_384) {
  const text = typeof value === "string" ? value : "";
  return text.length <= maxLength ? text : text.slice(-maxLength);
}

export function commandEvidence(result, name) {
  return {
    name,
    command: result.command,
    args: result.args,
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    status: result.exitCode === 0 ? "passed" : "failed",
    stdoutTail: outputTail(result.stdout),
    stderrTail: outputTail(result.stderr),
  };
}

export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export function sanitizeError(error, secrets = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) message = message.split(secret).join("[REDACTED]");
  }
  return message;
}
