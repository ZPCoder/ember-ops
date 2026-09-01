import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { preprovisionLoadRooms } from "../scripts/preprovision-load-rooms.mjs";

function fixture(now) {
  return {
    schemaVersion: 2,
    protocolVersion: "1.0",
    targetId: "cloudflare",
    probeId: "cn-mainland-east",
    sourceSha: "a".repeat(40),
    runId: "123-2-cloudflare-cn-mainland-east",
    disconnectAt: new Date(now + 60_000).toISOString(),
    expiresAt: new Date(now + 15 * 60_000).toISOString(),
    rooms: Array.from({ length: 250 }, (_value, roomIndex) => ({
      roomIndex,
      matchId: `match-${roomIndex}`,
      stateVersion: 1,
      cursor: 2,
      players: [0, 1].map((seat) => ({ seat, token: `secret-token-${roomIndex}-${seat}` })),
    })),
  };
}

test("pre-provisioning mints a fresh validated 250-room fixture without logging credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ember-preprovision-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputPath = join(root, "fixture.json");
  const now = Date.now();
  let request;
  const evidence = await preprovisionLoadRooms({
    endpoint: "https://integration.example.invalid/v1/admin/load-fixtures",
    token: "admin-secret",
    targetId: "cloudflare",
    probeId: "cn-mainland-east",
    sourceSha: "a".repeat(40),
    runId: "123-2-cloudflare-cn-mainland-east",
    outputPath,
    now,
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return { ok: true, status: 201, json: async () => ({ fixture: fixture(now) }) };
    },
  });
  assert.equal(request.url, "https://integration.example.invalid/v1/admin/load-fixtures");
  assert.equal(request.options.headers.authorization, "Bearer admin-secret");
  assert.equal(request.options.headers["idempotency-key"], "load-123-2-cloudflare-cn-mainland-east");
  assert.deepEqual(JSON.parse(request.options.body), {
    schemaVersion: 2,
    protocolVersion: "1.0",
    targetId: "cloudflare",
    probeId: "cn-mainland-east",
    sourceSha: "a".repeat(40),
    runId: "123-2-cloudflare-cn-mainland-east",
    roomCount: 250,
    logicalClients: 500,
    disconnectAfterSeconds: 60,
    expiresAfterSeconds: 900,
  });
  assert.equal(evidence.roomCount, 250);
  assert.equal(evidence.logicalClients, 500);
  assert.equal(JSON.stringify(evidence).includes("secret-token"), false);
  assert.equal(JSON.parse(await readFile(outputPath, "utf8")).rooms.length, 250);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
});

test("pre-provisioning rejects insecure endpoints before sending the token", async () => {
  let called = false;
  await assert.rejects(preprovisionLoadRooms({
    endpoint: "http://integration.example.invalid/v1/admin/load-fixtures",
    token: "admin-secret",
    targetId: "cloudflare",
    probeId: "cn-mainland-east",
    sourceSha: "a".repeat(40),
    runId: "123-2-cloudflare-cn-mainland-east",
    outputPath: "/tmp/unused-ember-fixture.json",
    fetchImpl: async () => { called = true; },
  }), /endpoint must use HTTPS/);
  assert.equal(called, false);
});
