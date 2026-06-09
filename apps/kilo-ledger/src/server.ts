import {
  applyFunding,
  applyMonthlyFunding,
  createDiscretionaryBucket,
  deleteDiscretionaryBucket,
  formatCents,
  KiloLedgerStore,
  parseDollarAmountToCents,
  reconcileKiloLedger,
  recordKiloSpend,
  resolveTangoProfileConfigDir,
  settleKiloSpending,
  summarizeKiloLedger,
  transferBetweenBuckets,
  type KiloActor,
  type KiloLedgerMutationResult,
} from "@tango/core";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 9320;

interface ServerOptions {
  host: string;
  port: number;
  token?: string;
  allowUnauthenticated: boolean;
  basePath: string;
  publicDir: string;
  ledgerPath?: string;
}

interface ActionBody {
  actor?: string;
  amount?: string | number;
  amount_cents?: number;
  bucket_id?: string;
  bucket_name?: string;
  description?: string;
  external_balance?: string | number;
  external_balance_cents?: number;
  external_id?: string;
  from_bucket_id?: string;
  note?: string;
  overwrite?: boolean;
  source?: string;
  spend_movement_ids?: string[];
  to_bucket_id?: string;
  transfer_to_bucket_id?: string;
  allocations?: Array<{
    bucket_id: string;
    amount?: string | number;
    amount_cents?: number;
  }>;
}

export function startKiloLedgerServer(options = resolveServerOptions()): http.Server {
  assertSafeBind(options);
  const store = new KiloLedgerStore({ filePath: options.ledgerPath });

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, options, store);
    } catch (error) {
      respondJson(res, statusForError(error), {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.listen(options.port, options.host, () => {
    console.log(`[kilo-ledger] listening on http://${options.host}:${options.port}`);
    console.log(`[kilo-ledger] ledger=${store.filePath}`);
  });
  return server;
}

export function resolveServerOptions(): ServerOptions {
  const publicDir = resolvePublicDir();
  return {
    host: process.env.KILO_LEDGER_HOST?.trim() || "127.0.0.1",
    port: Number.parseInt(process.env.KILO_LEDGER_PORT || String(DEFAULT_PORT), 10),
    token: process.env.KILO_LEDGER_TOKEN?.trim() || undefined,
    allowUnauthenticated: process.env.KILO_ALLOW_UNAUTHENTICATED === "1",
    basePath: normalizeBasePath(process.env.KILO_BASE_PATH ?? ""),
    publicDir,
    ledgerPath: process.env.KILO_LEDGER_PATH?.trim() || undefined,
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServerOptions,
  store: KiloLedgerStore,
): Promise<void> {
  const incomingUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const url = stripBasePath(incomingUrl, options.basePath, res);
  if (!url) {
    return;
  }

  if (url.pathname === "/api/health") {
    respondJson(res, 200, { ok: true, ledgerPath: store.filePath });
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    if (!isAuthorized(req, options)) {
      respondJson(res, 401, { error: "Unauthorized" });
      return;
    }
    await handleApiRequest(req, res, url, store);
    return;
  }

  serveStatic(res, options.publicDir, url.pathname);
}

async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: KiloLedgerStore,
): Promise<void> {
  if (req.method === "GET" && url.pathname === "/api/ledger") {
    respondLedger(res, store);
    return;
  }

  if (req.method !== "POST") {
    respondJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const body = await readJsonBody(req);
  const actor = normalizeActor(body.actor);

  if (url.pathname === "/api/initialize") {
    const ledger = store.initialize({ overwrite: body.overwrite === true });
    respondJson(res, 200, buildLedgerPayload(store, { ledger }));
    return;
  }

  if (url.pathname === "/api/buckets/create") {
    const result = store.mutate((ledger) => createDiscretionaryBucket(ledger, {
      name: requiredString(body.bucket_name, "bucket_name"),
      actor,
      source: "kilo-web",
    }));
    await notifyFoxtrot(result, store.filePath);
    respondJson(res, 200, buildLedgerPayload(store, result));
    return;
  }

  if (url.pathname === "/api/buckets/delete") {
    const result = store.mutate((ledger) => deleteDiscretionaryBucket(ledger, {
      bucketId: requiredString(body.bucket_id, "bucket_id"),
      transferToBucketId: optionalString(body.transfer_to_bucket_id),
      actor,
      source: "kilo-web",
    }));
    await notifyFoxtrot(result, store.filePath);
    respondJson(res, 200, buildLedgerPayload(store, result));
    return;
  }

  if (url.pathname === "/api/transfer") {
    const result = store.mutate((ledger) => transferBetweenBuckets(ledger, {
      fromBucketId: requiredString(body.from_bucket_id, "from_bucket_id"),
      toBucketId: requiredString(body.to_bucket_id, "to_bucket_id"),
      amountCents: centsFromBody(body),
      actor,
      description: optionalString(body.description),
      source: "kilo-web",
    }));
    await notifyFoxtrot(result, store.filePath);
    respondJson(res, 200, buildLedgerPayload(store, result));
    return;
  }

  if (url.pathname === "/api/funding/monthly") {
    const result = store.mutate((ledger) => applyMonthlyFunding(ledger, {
      amountCents: centsFromBody(body, ledger.settings.monthlyContributionCents),
      actor,
      description: optionalString(body.description) ?? "Applied Kilo monthly funding.",
      source: optionalString(body.source) ?? "monthly-funding",
      externalId: optionalString(body.external_id),
    }));
    await notifyFoxtrot(result, store.filePath);
    respondJson(res, 200, buildLedgerPayload(store, result));
    return;
  }

  if (url.pathname === "/api/funding/weekly") {
    const result = store.mutate((ledger) => applyFunding(ledger, {
      amountCents: centsFromBody(body, ledger.settings.weeklyContributionCents),
      actor,
      description: optionalString(body.description) ?? "Applied legacy Kilo weekly funding.",
      source: optionalString(body.source) ?? "legacy-weekly-funding",
      externalId: optionalString(body.external_id),
    }));
    await notifyFoxtrot(result, store.filePath);
    respondJson(res, 200, buildLedgerPayload(store, result));
    return;
  }

  if (url.pathname === "/api/funding/custom") {
    const amountCents = centsFromBody(body);
    const result = store.mutate((ledger) => applyFunding(ledger, {
      amountCents,
      actor,
      allocations: parseAllocations(body.allocations, amountCents),
      description: optionalString(body.description),
      source: "kilo-web",
      externalId: optionalString(body.external_id),
    }));
    await notifyFoxtrot(result, store.filePath);
    respondJson(res, 200, buildLedgerPayload(store, result));
    return;
  }

  if (url.pathname === "/api/spend") {
    const result = store.mutate((ledger) => recordKiloSpend(ledger, {
      bucketId: requiredString(body.bucket_id, "bucket_id"),
      amountCents: centsFromBody(body),
      actor,
      description: optionalString(body.description),
      source: optionalString(body.source) ?? "foxtrot-review",
      externalId: optionalString(body.external_id),
    }));
    await notifyFoxtrot(result, store.filePath);
    respondJson(res, 200, buildLedgerPayload(store, result));
    return;
  }

  if (url.pathname === "/api/settlements") {
    const result = store.mutate((ledger) => settleKiloSpending(ledger, {
      amountCents: centsFromBody(body),
      actor,
      description: optionalString(body.description),
      source: optionalString(body.source) ?? "bank-settlement",
      externalId: optionalString(body.external_id),
      spendMovementIds: parseSpendMovementIds(body.spend_movement_ids),
    }));
    await notifyFoxtrot(result, store.filePath);
    respondJson(res, 200, buildLedgerPayload(store, result));
    return;
  }

  if (url.pathname === "/api/reconcile") {
    const result = store.mutate((ledger) => reconcileKiloLedger(ledger, {
      externalBalanceCents: externalBalanceFromBody(body),
      source: optionalString(body.source) ?? "manual",
      note: optionalString(body.note),
    }));
    await notifyFoxtrot(result, store.filePath);
    respondJson(res, 200, buildLedgerPayload(store, result));
    return;
  }

  respondJson(res, 404, { error: "Not found" });
}

function respondLedger(res: ServerResponse, store: KiloLedgerStore): void {
  respondJson(res, 200, buildLedgerPayload(store, { ledger: store.read() }));
}

function buildLedgerPayload(
  store: KiloLedgerStore,
  result: Pick<KiloLedgerMutationResult, "ledger" | "movement" | "movements" | "reconciliation" | "idempotent">,
): Record<string, unknown> {
  return {
    ledgerPath: store.filePath,
    exists: fs.existsSync(store.filePath),
    summary: summarizeKiloLedger(result.ledger),
    movement: result.movement,
    movements: result.movements,
    reconciliation: result.reconciliation,
    idempotent: result.idempotent === true,
  };
}

async function notifyFoxtrot(result: KiloLedgerMutationResult, ledgerPath: string): Promise<void> {
  if (result.idempotent) {
    return;
  }
  const token = process.env.DISCORD_TOKEN;
  const channelId =
    process.env.KILO_REPORT_CHANNEL_ID
    ?? process.env.FOXTROT_CHANNEL_ID
    ?? resolveFoxtrotChannelIdFromProfile();
  if (!token || !channelId) {
    return;
  }

  const lines = formatNotificationLines(result);
  if (lines.length === 0) {
    return;
  }

  try {
    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: [
          "**Kilo web ledger update**",
          ...lines.map((line) => `- ${line}`),
          `- Ledger total: ${formatCents(result.ledger.totalCents)}`,
          `- Ledger path: \`${ledgerPath}\``,
        ].join("\n"),
      }),
    });
    if (!response.ok) {
      console.warn(`[kilo-ledger] Foxtrot report failed: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    console.warn(`[kilo-ledger] Foxtrot report failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function formatNotificationLines(result: KiloLedgerMutationResult): string[] {
  const movements = [...(result.movements ?? []), ...(result.movement ? [result.movement] : [])];
  const movementLines = movements.map((movement) => {
    const amount = formatCents(movement.amountCents);
    if (movement.type === "transfer") {
      return `${movement.actor} moved ${amount} from ${bucketName(result, movement.fromBucketId)} to ${bucketName(result, movement.toBucketId)}.`;
    }
    if (movement.type === "funding" && movement.allocations) {
      const allocations = movement.allocations
        .map((allocation) => `${bucketName(result, allocation.bucketId)} ${formatCents(allocation.amountCents)}`)
        .join(", ");
      return `${movement.actor} funded ${amount}: ${allocations}.`;
    }
    if (movement.type === "spend") {
      return `${movement.actor} recorded ${amount} spending from ${bucketName(result, movement.fromBucketId)}; pending bank settlement.`;
    }
    if (movement.type === "settlement") {
      const count = movement.settledMovementIds?.length ?? 0;
      const suffix = count > 0 ? ` across ${count} spend${count === 1 ? "" : "s"}` : "";
      return `${movement.actor} settled ${amount} of already-recorded Kilo spending${suffix}; balances unchanged.`;
    }
    if (movement.type === "bucket_create") {
      return `${movement.actor} created ${bucketName(result, movement.toBucketId)}.`;
    }
    if (movement.type === "bucket_delete") {
      return `${movement.actor} deleted ${movement.fromBucketId ?? "a bucket"}.`;
    }
    return `${movement.actor} updated Kilo.`;
  });

  const reconciliation = result.reconciliation;
  if (!reconciliation) {
    return movementLines;
  }
  if (reconciliation.status === "drift" && reconciliation.externalBalanceCents != null && reconciliation.driftCents != null) {
    movementLines.push(
      `Drift warning: ledger ${formatCents(reconciliation.ledgerTotalCents)}, pending settlement ${formatCents(reconciliation.pendingSettlementCents)}, expected external ${formatCents(reconciliation.expectedExternalBalanceCents)}, external ${formatCents(reconciliation.externalBalanceCents)}, drift ${formatCents(reconciliation.driftCents)}. Writes remain allowed.`,
    );
  } else if (reconciliation.status === "unavailable") {
    movementLines.push("Reconciliation unavailable. Writes remain allowed.");
  }
  return movementLines;
}

function bucketName(result: KiloLedgerMutationResult, bucketId?: string): string {
  if (!bucketId) return "unknown";
  return result.ledger.buckets.find((bucket) => bucket.id === bucketId)?.name ?? bucketId;
}

function serveStatic(res: ServerResponse, publicDir: string, pathname: string): void {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/u, "");
  const resolved = path.resolve(publicDir, requested);
  if (!resolved.startsWith(path.resolve(publicDir))) {
    respondJson(res, 403, { error: "Forbidden" });
    return;
  }
  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    respondJson(res, 404, { error: "Not found" });
    return;
  }
  const ext = path.extname(resolved);
  res.writeHead(200, {
    "Content-Type": contentType(ext),
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=60",
  });
  fs.createReadStream(resolved).pipe(res);
}

function stripBasePath(url: URL, basePath: string, res: ServerResponse): URL | undefined {
  if (!basePath) {
    return url;
  }
  if (url.pathname === basePath) {
    res.writeHead(308, { Location: `${basePath}/${url.search}` });
    res.end();
    return undefined;
  }
  if (!url.pathname.startsWith(`${basePath}/`)) {
    return url;
  }
  const stripped = new URL(url.href);
  stripped.pathname = url.pathname.slice(basePath.length) || "/";
  return stripped;
}

function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/u, "");
}

function contentType(ext: string): string {
  switch (ext) {
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".html": return "text/html; charset=utf-8";
    default: return "application/octet-stream";
  }
}

function isAuthorized(req: IncomingMessage, options: ServerOptions): boolean {
  if (!options.token) {
    return true;
  }
  const auth = req.headers.authorization;
  if (auth === `Bearer ${options.token}`) {
    return true;
  }
  return req.headers["x-kilo-token"] === options.token;
}

function assertSafeBind(options: ServerOptions): void {
  if (options.allowUnauthenticated || options.token || isLoopbackHost(options.host)) {
    return;
  }
  throw new Error(
    "Refusing to bind Kilo ledger to a non-loopback host without KILO_LEDGER_TOKEN. " +
    "Set KILO_LEDGER_TOKEN or KILO_ALLOW_UNAUTHENTICATED=1.",
  );
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function resolvePublicDir(): string {
  const configured = process.env.KILO_PUBLIC_DIR?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), "apps/kilo-ledger/src/public"),
    path.resolve(process.cwd(), "src/public"),
    path.resolve(here, "../src/public"),
    path.resolve(here, "public"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(path.join(candidate, "index.html")));
  if (!found) {
    throw new Error("Could not locate Kilo public assets.");
  }
  return found;
}

function resolveFoxtrotChannelIdFromProfile(): string | undefined {
  const channelsPath = path.join(resolveTangoProfileConfigDir(), "channels.yaml");
  if (!fs.existsSync(channelsPath)) {
    return undefined;
  }
  const lines = fs.readFileSync(channelsPath, "utf8").split(/\r?\n/u);
  let section = "";
  const values = new Map<string, string>();
  for (const line of lines) {
    const sectionMatch = /^([a-zA-Z0-9_-]+):\s*$/u.exec(line);
    if (sectionMatch?.[1]) {
      section = sectionMatch[1];
      continue;
    }
    const valueMatch = /^\s+([a-zA-Z0-9_-]+):\s*["']?([0-9]+)["']?\s*$/u.exec(line);
    if (valueMatch?.[1] && valueMatch[2]) {
      values.set(`${section}.${valueMatch[1]}`, valueMatch[2]);
    }
  }
  return values.get("agents.foxtrot") ?? values.get("topics.finance");
}

async function readJsonBody(req: IncomingMessage): Promise<ActionBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as ActionBody;
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function statusForError(error: unknown): number {
  if (!(error instanceof Error)) {
    return 500;
  }
  return isClientErrorMessage(error.message) ? 400 : 500;
}

function isClientErrorMessage(message: string): boolean {
  return [
    " is required",
    "Invalid actor",
    "Invalid dollar amount",
    "Amount must",
    "Amount cannot",
    "Expected integer cents",
    "Bucket name must",
    "Invalid bucket id",
    "Unknown Kilo bucket",
    "Choose two different buckets",
    "protected",
    "only has",
    "has a balance",
    "cannot go below",
    "Allocations total",
    "External id",
    "No unsettled",
    "Could not match",
    "Settlement selected",
    "spend movements",
  ].some((snippet) => message.includes(snippet));
}

function normalizeActor(value: unknown): KiloActor {
  const actor = typeof value === "string" ? value.trim().toLowerCase() : "child";
  if (actor === "child" || actor === "owner" || actor === "foxtrot" || actor === "system") {
    return actor;
  }
  throw new Error(`Invalid actor: ${actor}`);
}

function requiredString(value: unknown, name: string): string {
  const normalized = optionalString(value);
  if (!normalized) {
    throw new Error(`${name} is required.`);
  }
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function centsFromBody(body: ActionBody, fallback?: number): number {
  if (typeof body.amount_cents === "number") {
    return body.amount_cents;
  }
  if (typeof body.amount === "string" || typeof body.amount === "number") {
    return parseDollarAmountToCents(body.amount);
  }
  if (fallback != null) {
    return fallback;
  }
  throw new Error("amount is required.");
}

function externalBalanceFromBody(body: ActionBody): number | null {
  if (typeof body.external_balance_cents === "number") {
    return body.external_balance_cents;
  }
  if (typeof body.external_balance === "string" || typeof body.external_balance === "number") {
    return parseDollarAmountToCents(body.external_balance);
  }
  return null;
}

function parseAllocations(
  allocations: ActionBody["allocations"],
  expectedTotalCents: number,
): Array<{ bucketId: string; amountCents: number }> | undefined {
  if (!allocations) {
    return undefined;
  }
  const parsed = allocations.map((allocation) => ({
    bucketId: allocation.bucket_id,
    amountCents: typeof allocation.amount_cents === "number"
      ? allocation.amount_cents
      : parseDollarAmountToCents(allocation.amount ?? "0"),
  }));
  const total = parsed.reduce((sum, allocation) => sum + allocation.amountCents, 0);
  if (total !== expectedTotalCents) {
    throw new Error(`Allocations total ${formatCents(total)} but expected ${formatCents(expectedTotalCents)}.`);
  }
  return parsed;
}

function parseSpendMovementIds(value: unknown): string[] | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("spend_movement_ids must be an array.");
  }
  return value.map((entry) => requiredString(entry, "spend_movement_ids[]"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startKiloLedgerServer();
}
