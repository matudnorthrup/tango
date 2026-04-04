/**
 * 1Password Secret Resolver — Transparent credential fetching for tool handlers.
 *
 * Fetches secrets from 1Password via the CLI service account, caches them
 * in memory for the process lifetime. Used by tool handlers that need
 * API keys or credentials at runtime.
 *
 * Falls back gracefully: if OP_SERVICE_ACCOUNT_TOKEN is not set or the
 * item doesn't exist, returns null so callers can use legacy sources.
 */

import { spawn } from "node:child_process";

const debug = (...args: unknown[]) => {
  console.error("[op-secret]", ...args);
};

const OP_BINARY = "/opt/homebrew/bin/op";

// In-memory cache: "vault/item/field" → value
const cache = new Map<string, string>();

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function execOp(args: string[], token: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(OP_BINARY, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: token },
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 2000).unref();
    }, 15_000);
    timer.unref();

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.end();
  });
}

/**
 * Fetch a secret from 1Password. Returns the field value or null if unavailable.
 * Results are cached in memory after first fetch.
 */
export async function getSecret(
  vault: string,
  item: string,
  field = "credential",
): Promise<string | null> {
  const token = process.env.OP_SERVICE_ACCOUNT_TOKEN;
  if (!token) return null;

  const cacheKey = `${vault}/${item}/${field}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const result = await execOp(
      ["item", "get", item, "--vault", vault, "--fields", field, "--reveal"],
      token,
    );

    if (result.code !== 0) {
      debug(`Failed to get "${item}" from "${vault}": ${result.stderr.trim()}`);
      return null;
    }

    const value = result.stdout.trim();
    if (!value) {
      debug(`Empty value for "${item}" field "${field}" in "${vault}"`);
      return null;
    }

    cache.set(cacheKey, value);
    debug(`Resolved secret: ${vault}/${item}/${field}`);
    return value;
  } catch (err) {
    debug(`Error fetching secret "${item}":`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Check if 1Password integration is available (token is set).
 */
export function isOpAvailable(): boolean {
  return !!process.env.OP_SERVICE_ACCOUNT_TOKEN;
}
