/**
 * Ward Program agent tools — let Porter drive the Waldport Ward program's
 * "apply weekly data → build → deploy" engine without shell/filesystem access.
 *
 * Each tool shells out to the engine CLI in the ward-program repo
 * (scripts/update-program.mjs), which takes structured JSON and returns
 * structured JSON. Update/build/commit happen on the `staging` branch
 * (reviewable at staging.waldportward.org); promote publishes to production.
 *
 * The engine owns all the risky parts (git, build, deploy) and reports its
 * result as JSON — these tools are a thin, typed pass-through.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@tango/core";

const execFileAsync = promisify(execFile);

function wardProgramDir(): string {
  if (process.env.WARD_PROGRAM_DIR) return process.env.WARD_PROGRAM_DIR;
  const profile = process.env.TANGO_PROFILE || "default";
  return path.join(os.homedir(), ".tango", "profiles", profile, "ward-program");
}

async function runEngine(args: string[]): Promise<unknown> {
  const dir = wardProgramDir();
  const engine = path.join(dir, "scripts", "update-program.mjs");
  try {
    const { stdout } = await execFileAsync("node", [engine, ...args], {
      cwd: dir,
      timeout: 300_000,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    });
    try { return JSON.parse(stdout); } catch { return { ok: false, error: "engine produced non-JSON output", raw: stdout.slice(-1500) }; }
  } catch (err: unknown) {
    // The engine exits non-zero on failure but still prints a JSON {ok:false,...} to stdout.
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const out = (e.stdout || "").toString();
    try { return JSON.parse(out); } catch { /* fall through */ }
    return { ok: false, error: (e.stderr || e.message || "engine error").toString().slice(0, 800) };
  }
}

const nameCalling = {
  type: "object",
  properties: { name: { type: "string" }, calling: { type: "string" } },
  required: ["name", "calling"],
  additionalProperties: false,
};

export function createWardProgramTools(): AgentTool[] {
  return [
    {
      name: "ward_program_status",
      description:
        "Report the Waldport Ward program's current week, staging + production URLs, and whether staging can be promoted to production. Read-only; makes no changes.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => runEngine(["--status"]),
    },
    {
      name: "ward_program_update",
      description: [
        "Apply a structured weekly update to the Waldport Ward sacrament-meeting program, then build and commit it to STAGING (reviewable at staging.waldportward.org — NOT yet public).",
        "Pass only the fields that change. It does not publish to production; use ward_program_promote for that.",
        "Returns the applied changes and the staging URL.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          speakers: { type: "array", items: { type: "string" }, description: "Speaker names in order; rebuilds the agenda with an intermediate hymn before the last speaker." },
          fastSunday: { type: "boolean", description: "Fast & Testimony meeting — the meeting middle becomes Testimonies instead of speakers." },
          testimonies: { type: "string", description: "Custom testimony label (implies a fast Sunday)." },
          prayers: { type: "object", properties: { invocation: { type: "string" }, benediction: { type: "string" } }, additionalProperties: false },
          announcements: {
            type: "array",
            description: "REPLACES the announcement list — send every announcement that should remain, not just the new one. Each item: title, date, time, location, optional until (ISO YYYY-MM-DD — auto-expires after this), tier ('critical' to also show on the printed program), detail, link, short.",
            items: {
              type: "object",
              properties: {
                title: { type: "string" }, date: { type: "string" }, time: { type: "string" }, location: { type: "string" },
                until: { type: "string", description: "ISO YYYY-MM-DD; the announcement stops showing on programs dated after this." },
                tier: { type: "string", enum: ["critical"], description: "'critical' to also appear on the printed program (digital shows all)." },
                detail: { type: "string" }, link: { type: "string" }, linkLabel: { type: "string" },
                short: {
                  type: "string",
                  description: [
                    "Short-link code for `link`, so the printed program reads e.g. 'waldportward.org/service-day' instead of a long sign-up URL.",
                    "Set this whenever `link` is long or unreadable (a Google Form, an Eventbrite id, anything with a query string) — a long URL is unusable on a printed program someone has to retype.",
                    "Use 2–32 lowercase letters, numbers, or dashes, and prefer a readable word over a code ('service-day', not '23se') since people retype it off paper.",
                    "Use a UNIQUE code per event; codes never expire, so reusing one repoints the older program's link too.",
                    "The build registers the redirect automatically — it goes live when the program is promoted, not before.",
                  ].join(" "),
                },
              },
              required: ["title"],
              additionalProperties: false,
            },
          },
          callings: {
            type: "object",
            properties: { releases: { type: "array", items: nameCalling }, sustainings: { type: "array", items: nameCalling } },
            additionalProperties: false,
          },
          presiding: { type: "string", description: "Presiding officer, or 'auto' to use the standing schedule." },
          conducting: { type: "string", description: "Conducting officer, or 'auto' to use the standing schedule." },
          contact: { type: "object", properties: { name: { type: "string" }, phone: { type: "string" } }, additionalProperties: false },
          date: { type: "string", description: "YYYY-MM-DD Sunday to roll the program to (usually omitted — the program is already on the right week)." },
        },
        additionalProperties: false,
      },
      handler: async (input) => runEngine([`--json=${JSON.stringify(input ?? {})}`]),
    },
    {
      name: "ward_program_promote",
      description:
        "Promote the Waldport Ward program from staging to PRODUCTION (waldportward.org): fast-forward production to staging and deploy. This PUBLISHES to the public site and the printed/QR'd bulletin. Only call when the user explicitly asks to promote / publish / go live.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => runEngine(["--promote"]),
    },
  ];
}
