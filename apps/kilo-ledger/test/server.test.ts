import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startKiloLedgerServer } from "../src/server.js";

const tempDirs: string[] = [];
const servers: http.Server[] = [];
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/public");
let savedDiscordToken: string | undefined;
let savedKiloReportChannelId: string | undefined;
let savedFoxtrotChannelId: string | undefined;

beforeEach(() => {
  savedDiscordToken = process.env.DISCORD_TOKEN;
  savedKiloReportChannelId = process.env.KILO_REPORT_CHANNEL_ID;
  savedFoxtrotChannelId = process.env.FOXTROT_CHANNEL_ID;
  delete process.env.DISCORD_TOKEN;
  delete process.env.KILO_REPORT_CHANNEL_ID;
  delete process.env.FOXTROT_CHANNEL_ID;
});

afterEach(async () => {
  restoreEnv("DISCORD_TOKEN", savedDiscordToken);
  restoreEnv("KILO_REPORT_CHANNEL_ID", savedKiloReportChannelId);
  restoreEnv("FOXTROT_CHANNEL_ID", savedFoxtrotChannelId);

  await Promise.all(servers.splice(0).map(closeServer));
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Kilo ledger web server", () => {
  it("serves the bookmarkable page and health endpoint", async () => {
    const { baseUrl, ledgerPath } = await startTestServer();

    const health = await fetch(`${baseUrl}/api/health`);
    const page = await fetch(baseUrl);

    expect(await health.json()).toEqual({ ok: true, ledgerPath });
    expect(await page.text()).toContain("<title>Kilo</title>");
  });

  it("serves the page and API under a /kilo base path", async () => {
    const { baseUrl } = await startTestServer({ basePath: "/kilo" });

    const page = await fetch(`${baseUrl}/kilo/`);
    const script = await fetch(`${baseUrl}/kilo/app.js`);
    const ledger = await fetch(`${baseUrl}/kilo/api/ledger`);

    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain("<title>Kilo</title>");
    expect(html).toContain('id="historyList"');
    expect(html).toContain('href="style.css"');
    expect(html).toContain('src="app.js"');
    expect(script.status).toBe(200);
    const scriptBody = await script.text();
    expect(scriptBody).toContain("basePath");
    expect(scriptBody).toContain("renderHistory");
    expect(ledger.status).toBe(200);
  });

  it("requires a token for API calls when configured", async () => {
    const { baseUrl } = await startTestServer({ token: "secret-kilo-token" });

    const unauthorized = await fetch(`${baseUrl}/api/ledger`);
    const authorized = await fetch(`${baseUrl}/api/ledger`, {
      headers: { Authorization: "Bearer secret-kilo-token" },
    });

    expect(unauthorized.status).toBe(401);
    expect(authorized.status).toBe(200);
  });

  it("applies monthly funding and keeps protected buckets locked", async () => {
    const { baseUrl } = await startTestServer();

    await postJson(baseUrl, "/api/initialize", {});
    const funded = await postJson(baseUrl, "/api/funding/monthly", {
      actor: "owner",
      external_id: "bank:kilo:2026-07",
    });
    const blocked = await fetch(`${baseUrl}/api/transfer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actor: "child",
        from_bucket_id: "savings",
        to_bucket_id: "recreation",
        amount: "1",
      }),
    });

    expect(funded.summary.total).toBe("$80.00");
    expect(funded.summary.buckets.find((bucket: { id: string }) => bucket.id === "tithing")?.balance).toBe("$8.00");
    expect(funded.summary.buckets.find((bucket: { id: string }) => bucket.id === "savings")?.balance).toBe("$24.00");
    expect(funded.summary.buckets.find((bucket: { id: string }) => bucket.id === "to-allocate")?.balance).toBe("$48.00");
    expect(blocked.status).toBe(400);
    expect(await blocked.json()).toMatchObject({ error: expect.stringContaining("Savings is protected") });
  });

  it("records spend settlement through the background API without changing balances twice", async () => {
    const { baseUrl } = await startTestServer();

    await postJson(baseUrl, "/api/initialize", {});
    await postJson(baseUrl, "/api/funding/monthly", { actor: "owner" });
    await postJson(baseUrl, "/api/transfer", {
      actor: "child",
      from_bucket_id: "to-allocate",
      to_bucket_id: "recreation",
      amount: "20",
    });
    const spend = await postJson(baseUrl, "/api/spend", {
      actor: "foxtrot",
      bucket_id: "recreation",
      amount: "14.99",
      external_id: "lm:purchase:123",
    });
    const settled = await postJson(baseUrl, "/api/settlements", {
      actor: "owner",
      amount: "14.99",
      external_id: "lm:settlement:999",
    });

    expect(spend.summary.total).toBe("$65.01");
    expect(spend.summary.pendingSettlement).toBe("$14.99");
    expect(spend.summary.expectedExternalBalance).toBe("$80.00");
    expect(settled.summary.total).toBe("$65.01");
    expect(settled.summary.pendingSettlement).toBe("$0.00");
    expect(settled.movement).toMatchObject({ type: "settlement" });
  });

  it("refuses non-loopback unauthenticated hosting", () => {
    const ledgerPath = createTempLedgerPath();

    expect(() => startKiloLedgerServer({
      host: "0.0.0.0",
      port: 0,
      allowUnauthenticated: false,
      publicDir,
      ledgerPath,
    })).toThrow("Refusing to bind Kilo ledger");
  });
});

async function startTestServer(
  input: { token?: string; basePath?: string } = {},
): Promise<{ baseUrl: string; ledgerPath: string }> {
  const ledgerPath = createTempLedgerPath();
  const server = startKiloLedgerServer({
    host: "127.0.0.1",
    port: 0,
    token: input.token,
    allowUnauthenticated: false,
    basePath: input.basePath ?? "",
    publicDir,
    ledgerPath,
  });
  servers.push(server);
  if (!server.listening) {
    await once(server, "listening");
  }
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    ledgerPath,
  };
}

function createTempLedgerPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-kilo-web-"));
  tempDirs.push(dir);
  return path.join(dir, "ledger.json");
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function postJson(baseUrl: string, pathname: string, body: Record<string, unknown>): Promise<any> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  expect(response.ok).toBe(true);
  return payload;
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
