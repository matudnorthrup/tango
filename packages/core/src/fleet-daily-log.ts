import fs from "node:fs";
import path from "node:path";
import { resolveTangoProfileDir, type TangoProfilePathOptions } from "./runtime-paths.js";

export type FleetDailyLogCapturedBy = "save_pass" | "agent_save";

export interface FleetDailyLogBlockMetadata {
  agent_id: string;
  date: string;
  time: string;
  channel_id: string;
  thread_id?: string;
  conversation_key: string;
  captured_by: FleetDailyLogCapturedBy;
  requested_by_user_id?: string;
  trigger?: string;
}

export interface EnsureFleetDailyLogOptions extends TangoProfilePathOptions {
  profileRoot?: string;
  now?: Date;
  timeZone?: string;
}

export interface EnsureFleetDailyLogResult {
  date: string;
  path: string;
  created: boolean;
}

export interface AppendFleetDailyLogOptions extends EnsureFleetDailyLogOptions {
  bullets: string[];
  metadata: FleetDailyLogBlockMetadata;
}

export interface AppendFleetDailyLogResult {
  date: string;
  path: string;
  block: string;
  createdFile: boolean;
}

const DEFAULT_TIME_ZONE = "America/Denver";
const appendLocks = new Map<string, Promise<void>>();

export function resolveFleetDailyLogPath(
  profileRoot: string,
  date: string,
): string {
  return path.join(profileRoot, "memory", `${date}.md`);
}

export function formatFleetDailyLogCalendarDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function formatFleetDailyLogTimestamp(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(now);

  const lookup = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  const year = lookup("year");
  const month = lookup("month");
  const day = lookup("day");
  const hour = lookup("hour");
  const minute = lookup("minute");
  const tz = lookup("timeZoneName");

  return `${year}-${month}-${day} ${hour}:${minute} ${tz}`.trim();
}

export function normalizeFleetDailyLogBullets(bullets: string[]): string[] {
  return bullets
    .map((bullet) => bullet.trim().replace(/^[-*]\s+/u, ""))
    .filter((bullet) => bullet.length > 0)
    .slice(0, 10);
}

export function formatFleetDailyLogBlock(
  metadata: FleetDailyLogBlockMetadata,
  bullets: string[],
): string {
  const normalizedBullets = normalizeFleetDailyLogBullets(bullets);
  if (normalizedBullets.length === 0) {
    throw new Error("daily_log_append requires at least one non-empty bullet");
  }

  const locationParts = [`channel:${metadata.channel_id}`];
  if (metadata.thread_id) {
    locationParts.push(`thread:${metadata.thread_id}`);
  }

  const header = `## ${metadata.agent_id} · ${metadata.time} · ${locationParts.join(" · ")}`;
  const lines = normalizedBullets.map((bullet) => `- ${bullet}`);
  return `${header}\n${lines.join("\n")}\n`;
}

export function ensureFleetDailyLog(
  options: EnsureFleetDailyLogOptions = {},
): EnsureFleetDailyLogResult {
  const profileRoot = options.profileRoot ?? resolveTangoProfileDir(options);
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const date = formatFleetDailyLogCalendarDate(now, timeZone);
  const logPath = resolveFleetDailyLogPath(profileRoot, date);

  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  if (fs.existsSync(logPath)) {
    return { date, path: logPath, created: false };
  }

  fs.writeFileSync(logPath, `# ${date}\n`, "utf8");
  return { date, path: logPath, created: true };
}

export async function appendFleetDailyLogBlock(
  options: AppendFleetDailyLogOptions,
): Promise<AppendFleetDailyLogResult> {
  const profileRoot = options.profileRoot ?? resolveTangoProfileDir(options);
  const block = formatFleetDailyLogBlock(options.metadata, options.bullets);
  const ensured = ensureFleetDailyLog({
    profileRoot,
    now: options.now,
    timeZone: options.timeZone,
  });

  await withAppendLock(ensured.path, async () => {
    const existing = fs.readFileSync(ensured.path, "utf8");
    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    fs.writeFileSync(ensured.path, `${existing}${separator}${block}`, "utf8");
  });

  return {
    date: ensured.date,
    path: ensured.path,
    block,
    createdFile: ensured.created,
  };
}

async function withAppendLock<T>(filePath: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = appendLocks.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  appendLocks.set(filePath, previous.then(() => gate));

  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}
