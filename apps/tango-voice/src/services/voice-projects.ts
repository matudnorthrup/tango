import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { TangoStorage } from '@tango/core';
import {
  ProjectDirectory,
  type VoiceProject,
} from '@tango/voice';
import { resolveSharedTangoConfigPath, resolveSharedTangoDbPath } from './shared-storage.js';

export interface VoiceProjectStorage {
  getFocusedProjectIdForChannel?(channelKey: string): string | null;
  setFocusedProjectForChannel?(channelKey: string, projectId: string | null): void;
  close?(): void;
}

export interface VoiceProjectDirectory {
  listProjects(): VoiceProject[];
  getProject(projectId: string | null | undefined): VoiceProject | null;
  resolveProjectQuery(query: string): VoiceProject | null;
}

function isVitestRuntime(): boolean {
  return Boolean(
    process.env.VITEST ||
      process.env.VITEST_POOL_ID ||
      process.argv.some((arg) => arg.toLowerCase().includes('vitest')),
  );
}

function createDefaultStorage(): VoiceProjectStorage {
  if (isVitestRuntime()) {
    const testDbPath = path.join(
      os.tmpdir(),
      `tango-voice-project-${process.pid}-${randomUUID()}.sqlite`,
    );
    return new TangoStorage(resolveSharedTangoDbPath(testDbPath));
  }

  return new TangoStorage(resolveSharedTangoDbPath());
}

function directoryHasProjectConfigs(configDir: string): boolean {
  return fs.existsSync(path.join(configDir, 'projects'));
}

function resolveDefaultProjectConfigDir(): string {
  const explicitEnvDir = process.env.TANGO_CONFIG_DIR?.trim();
  if (explicitEnvDir) return resolveSharedTangoConfigPath(explicitEnvDir);
  return resolveSharedTangoConfigPath();
}

export class VoiceProjectManager {
  private readonly fallbackFocusedProjectIdsByChannelKey = new Map<string, string>();
  private storage: VoiceProjectStorage | null = null;
  private readonly projectDirectory: VoiceProjectDirectory;

  constructor(options?: {
    storageFactory?: () => VoiceProjectStorage;
    projectDirectory?: VoiceProjectDirectory;
    configDir?: string;
  }) {
    this.storageFactory = options?.storageFactory ?? createDefaultStorage;
    this.projectDirectory =
      options?.projectDirectory ??
      new ProjectDirectory(options?.configDir ?? resolveDefaultProjectConfigDir());
  }

  private readonly storageFactory: () => VoiceProjectStorage;

  private getStorage(): VoiceProjectStorage {
    if (!this.storage) {
      this.storage = this.storageFactory();
    }
    return this.storage;
  }

  destroy(): void {
    this.storage?.close?.();
    this.storage = null;
  }

  reset(): void {
    this.fallbackFocusedProjectIdsByChannelKey.clear();
  }

  listProjects(): VoiceProject[] {
    return this.projectDirectory.listProjects();
  }

  getProject(projectId: string | null | undefined): VoiceProject | null {
    return this.projectDirectory.getProject(projectId);
  }

  resolveProjectQuery(query: string): VoiceProject | null {
    return this.projectDirectory.resolveProjectQuery(query);
  }

  getFocusedProjectId(channelKey: string): string | null {
    const storage = this.getStorage();
    const projectId = storage.getFocusedProjectIdForChannel
      ? storage.getFocusedProjectIdForChannel(channelKey)?.trim() || null
      : this.fallbackFocusedProjectIdsByChannelKey.get(channelKey)?.trim() || null;

    if (!projectId) return null;
    if (this.projectDirectory.getProject(projectId)) {
      return projectId;
    }

    if (storage.setFocusedProjectForChannel) {
      storage.setFocusedProjectForChannel(channelKey, null);
    } else {
      this.fallbackFocusedProjectIdsByChannelKey.delete(channelKey);
    }
    return null;
  }

  getFocusedProject(channelKey: string): VoiceProject | null {
    return this.projectDirectory.getProject(this.getFocusedProjectId(channelKey));
  }

  setFocusedProjectId(channelKey: string, projectId: string | null): void {
    const normalized = projectId?.trim() || null;
    if (normalized && !this.projectDirectory.getProject(normalized)) {
      throw new Error(`Project '${normalized}' not found.`);
    }

    const storage = this.getStorage();
    if (storage.setFocusedProjectForChannel) {
      storage.setFocusedProjectForChannel(channelKey, normalized);
      return;
    }

    if (!normalized) {
      this.fallbackFocusedProjectIdsByChannelKey.delete(channelKey);
      return;
    }

    this.fallbackFocusedProjectIdsByChannelKey.set(channelKey, normalized);
  }

  clearFocusedProject(channelKey: string): VoiceProject | null {
    const project = this.getFocusedProject(channelKey);
    const storage = this.getStorage();
    if (storage.setFocusedProjectForChannel) {
      storage.setFocusedProjectForChannel(channelKey, null);
    } else {
      this.fallbackFocusedProjectIdsByChannelKey.delete(channelKey);
    }
    return project;
  }

  resolveActiveProject(
    channelKey: string,
    options?: {
      topicActive?: boolean;
      topicProjectId?: string | null;
    },
  ): VoiceProject | null {
    if (options?.topicActive) {
      return this.projectDirectory.getProject(options.topicProjectId);
    }
    return this.getFocusedProject(channelKey);
  }
}
