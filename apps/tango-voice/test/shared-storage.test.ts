import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveTangoProfileDataDir } from '@tango/core';
import {
  resolveSharedTangoConfigPath,
  resolveSharedTangoDbPath,
} from '../src/services/shared-storage.js';

describe('shared-storage helpers', () => {
  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
  const originalCwd = process.cwd();
  const originalExistsSync = fs.existsSync;
  let existsSyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.chdir(repoRoot);
    vi.unstubAllEnvs();
    vi.stubEnv('TANGO_DB_PATH', '');
    vi.stubEnv('TANGO_CONFIG_DIR', '');
    vi.stubEnv('TANGO_DATA_DIR', '');
    existsSyncSpy = vi.spyOn(fs, 'existsSync').mockImplementation((target) => {
      if (path.resolve(String(target)) === path.resolve(repoRoot, 'data/tango.sqlite')) {
        return false;
      }
      return originalExistsSync(target);
    });
  });

  afterEach(() => {
    existsSyncSpy.mockRestore();
    vi.unstubAllEnvs();
    process.chdir(originalCwd);
  });

  it('defaults the Tango DB path to the profile data directory when no legacy DB exists', () => {
    expect(resolveSharedTangoDbPath()).toBe(
      path.resolve(resolveTangoProfileDataDir(), 'tango.sqlite'),
    );
  });

  it('defaults the Tango config path to the monorepo repo defaults directory', () => {
    expect(resolveSharedTangoConfigPath()).toBe(
      path.resolve(repoRoot, 'config/defaults'),
    );
  });
});
