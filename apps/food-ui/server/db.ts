import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Mirrors resolveWellnessDbPath in @tango/discord without pulling in that
// package (and its Discord dependencies). The bot owns schema migrations; this
// server only requires that the DB exists at the food-tracker version.
function resolveDbPath(): string {
  const configured =
    process.env.FOOD_UI_DB_PATH?.trim() ||
    process.env.JULES_WELLNESS_DB_PATH?.trim() ||
    process.env.WELLNESS_DB_PATH?.trim();
  if (configured) {
    return configured.startsWith('~') ? path.join(os.homedir(), configured.slice(1)) : configured;
  }
  const profile = process.env.TANGO_PROFILE?.trim() || 'default';
  return path.join(os.homedir(), '.tango', 'profiles', profile, 'wellness', 'wellness.db');
}

export const dbPath = resolveDbPath();

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `wellness.db not found at ${dbPath} — start the Tango bot once to materialize it (ensureWellnessDb).`,
    );
  }
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version < 2) {
    throw new Error(`wellness.db is at schema v${version}; food-ui needs v2+ (bot startup migrates).`);
  }
  return db;
}

export function all<T>(sql: string, params: Array<string | number | null> = []): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

export function one<T>(sql: string, params: Array<string | number | null> = []): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined;
}

export function run(sql: string, params: Array<string | number | null> = []): number {
  const result = getDb().prepare(sql).run(...params);
  return Number(result.lastInsertRowid);
}
