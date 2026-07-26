/**
 * Church session CLI — check, repair, and explain churchofjesuschrist.org auth.
 *
 *   npx tsx scripts/church-session.ts status     # report only, never signs in
 *   npx tsx scripts/church-session.ts ensure     # sign in if needed (study + LCR)
 *   npx tsx scripts/church-session.ts persist    # harden cookies against a restart
 *
 * Requires the repo .env (CHURCH_ACCOUNT_1PASSWORD_* and OP_SERVICE_ACCOUNT_TOKEN)
 * and the managed Brave on CDP 9223; it launches Brave if it is not running.
 */

import "dotenv/config";
import {
  churchSessionDiagnostics,
  ensureChurchSession,
  persistChurchSessionCookies,
  type ChurchScope,
} from "../packages/discord/src/church-session.ts";

const command = (process.argv[2] ?? "status").toLowerCase();

function reportDiagnostics(diagnostics: Record<string, unknown>): void {
  const profile = diagnostics.browserProfile as { expected: string; actual: string | null; matches: boolean | null };
  console.log("browser profile expected :", profile.expected);
  console.log("browser profile running  :", profile.actual ?? "(could not determine)");
  if (diagnostics.profileWarning) {
    console.log("WARNING:", diagnostics.profileWarning);
  }
  const credentials = diagnostics.credentials as { configured: boolean; opAvailable: boolean; missingConfig: string[] };
  console.log(
    "1Password              :",
    credentials.configured ? "configured" : `NOT configured (${credentials.missingConfig.join(", ")})`,
    credentials.opAvailable ? "| service account available" : "| service account TOKEN MISSING",
  );
  console.log("survives browser restart :", diagnostics.sessionSurvivesRestart ? "yes" : "NO");
  for (const entry of (diagnostics.sessionCookies as Array<Record<string, unknown>>) ?? []) {
    console.log(
      `  ${entry.survivesRestart ? "✓" : "✗"} ${entry.cookie} ${entry.expiresAt ? `(until ${entry.expiresAt})` : "(session only)"}`,
    );
  }
}

async function runEnsure(): Promise<number> {
  let failures = 0;
  for (const scope of ["study", "lcr"] as ChurchScope[]) {
    const result = await ensureChurchSession({ scope });
    console.log(`\n[${scope}] ${result.authenticated ? "OK" : "FAILED"} via ${result.path}`);
    console.log(`  ${result.message}`);
    if (!result.authenticated) {
      failures += 1;
      console.log("  steps:", JSON.stringify(result.steps, null, 2));
    }
  }
  return failures;
}

async function main(): Promise<number> {
  if (command === "status") {
    // Probe first: visiting LCR re-mints its session cookies, so reporting the
    // cookie state before the probe shows a stale picture.
    for (const scope of ["study", "lcr"] as ChurchScope[]) {
      const result = await ensureChurchSession({ scope, allowLogin: false });
      console.log(`[${scope}] authenticated: ${result.authenticated} — ${result.probe.detail}`);
    }
    console.log("");
    reportDiagnostics(await churchSessionDiagnostics());
    return 0;
  }
  if (command === "ensure") {
    const failures = await runEnsure();
    console.log("");
    reportDiagnostics(await churchSessionDiagnostics());
    return failures === 0 ? 0 : 1;
  }
  if (command === "persist") {
    const result = await persistChurchSessionCookies();
    console.log(JSON.stringify(result, null, 2));
    return result.error ? 1 : 0;
  }
  console.error(`Unknown command "${command}". Use status, ensure, or persist.`);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
