import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveConfigDir,
  resolveDatabasePath,
  resolveLegacyDatabasePath,
} from '@tango/core';

export function resolveSharedTangoDbPath(explicitPath?: string): string {
  if (explicitPath && explicitPath.trim().length > 0) {
    return resolveDatabasePath(explicitPath);
  }

  if (process.env.TANGO_DB_PATH?.trim()) {
    return resolveDatabasePath(process.env.TANGO_DB_PATH);
  }

  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const legacyDbPath = resolveLegacyDatabasePath(repoRoot);
  if (fs.existsSync(legacyDbPath)) {
    return legacyDbPath;
  }

  return resolveDatabasePath();
}

export function resolveSharedTangoConfigPath(explicitPath?: string): string {
  if (explicitPath && explicitPath.trim().length > 0) {
    return path.resolve(resolveConfigDir(explicitPath));
  }

  if (process.env.TANGO_CONFIG_DIR?.trim()) {
    return path.resolve(resolveConfigDir(process.env.TANGO_CONFIG_DIR));
  }

  return path.resolve(resolveConfigDir());
}
