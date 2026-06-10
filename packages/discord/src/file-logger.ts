import fs from "node:fs";
import path from "node:path";

const DEFAULT_RETAIN_DAYS = 14;

interface FileLogMirrorState {
  dir: string;
  retainDays: number;
  currentDate: string;
  stream: fs.WriteStream | null;
  broken: boolean;
}

let state: FileLogMirrorState | null = null;

function currentUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function openStream(mirror: FileLogMirrorState): fs.WriteStream | null {
  if (mirror.broken) return null;
  const date = currentUtcDate();
  if (mirror.stream && mirror.currentDate === date) {
    return mirror.stream;
  }

  try {
    mirror.stream?.end();
    fs.mkdirSync(mirror.dir, { recursive: true });
    mirror.currentDate = date;
    mirror.stream = fs.createWriteStream(path.join(mirror.dir, `bot-${date}.log`), {
      flags: "a",
    });
    // The mirror must never take the bot down with it.
    mirror.stream.on("error", () => {
      mirror.broken = true;
      mirror.stream = null;
    });
    pruneOldLogs(mirror);
    return mirror.stream;
  } catch {
    mirror.broken = true;
    mirror.stream = null;
    return null;
  }
}

function pruneOldLogs(mirror: FileLogMirrorState): void {
  try {
    const cutoff = Date.now() - mirror.retainDays * 24 * 60 * 60 * 1000;
    for (const entry of fs.readdirSync(mirror.dir)) {
      const match = entry.match(/^bot-(\d{4}-\d{2}-\d{2})\.log$/);
      if (!match?.[1]) continue;
      if (new Date(`${match[1]}T00:00:00Z`).getTime() < cutoff) {
        fs.rmSync(path.join(mirror.dir, entry), { force: true });
      }
    }
  } catch {
    // Retention is best-effort.
  }
}

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return arg.stack ?? arg.message;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

function writeLine(level: string, args: unknown[]): void {
  if (!state) return;
  const stream = openStream(state);
  if (!stream) return;
  try {
    stream.write(`${new Date().toISOString()} ${level} ${formatArgs(args)}\n`);
  } catch {
    state.broken = true;
  }
}

/**
 * Mirror console output to date-stamped files so bot logs survive restarts
 * (tmux scrollback is wiped on every restart — TGO-697). Disable with
 * TANGO_FILE_LOGS=0.
 */
export function installFileLogMirror(options: { dir: string; retainDays?: number }): void {
  if (state) return;
  if (process.env.TANGO_FILE_LOGS === "0") return;

  state = {
    dir: options.dir,
    retainDays: options.retainDays ?? DEFAULT_RETAIN_DAYS,
    currentDate: "",
    stream: null,
    broken: false,
  };

  const originals = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  console.log = (...args: unknown[]) => {
    originals.log(...args);
    writeLine("INFO", args);
  };
  console.warn = (...args: unknown[]) => {
    originals.warn(...args);
    writeLine("WARN", args);
  };
  console.error = (...args: unknown[]) => {
    originals.error(...args);
    writeLine("ERROR", args);
  };

  originals.log(`[tango-discord] file log mirror active: ${options.dir}`);
}
