import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveTangoProfileDataDir } from '@tango/core';
import {
  resolveSharedTangoConfigPath,
  resolveSharedTangoDbPath,
} from '../src/services/shared-storage.js';

describe('shared-storage helpers', () => {
  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

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
