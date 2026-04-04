import { describe, expect, it } from 'vitest';
import {
  VoiceProjectManager,
  type VoiceProjectDirectory,
  type VoiceProjectStorage,
} from '../src/services/voice-projects.js';

function createDirectory(): VoiceProjectDirectory {
  const projects = new Map([
    [
      'personal',
      {
        id: 'personal',
        displayName: 'Personal',
        aliases: ['personal'],
        defaultAgentId: 'watson',
        provider: { default: 'claude-oauth' },
      },
    ],
    [
      'tango',
      {
        id: 'tango',
        displayName: 'Tango MVP',
        aliases: ['tango mvp'],
        defaultAgentId: 'watson',
        provider: { default: 'claude-harness', fallback: ['codex'] },
      },
    ],
  ]);

  return {
    listProjects() {
      return [...projects.values()];
    },
    getProject(projectId) {
      if (!projectId) return null;
      return projects.get(projectId) ?? null;
    },
    resolveProjectQuery(query) {
      const normalized = query.trim().toLowerCase();
      return [...projects.values()].find((project) =>
        [project.id, project.displayName, ...project.aliases].some(
          (alias) => alias.toLowerCase() === normalized,
        ),
      ) ?? null;
    },
  };
}

function createStorage(): VoiceProjectStorage {
  const focusedProjectByChannel = new Map<string, string | null>();
  return {
    getFocusedProjectIdForChannel(channelKey) {
      return focusedProjectByChannel.get(channelKey)?.trim() || null;
    },
    setFocusedProjectForChannel(channelKey, projectId) {
      focusedProjectByChannel.set(channelKey, projectId?.trim() || null);
    },
  };
}

describe('VoiceProjectManager', () => {
  it('persists focused projects through shared storage instead of process memory', () => {
    const storage = createStorage();
    const projectDirectory = createDirectory();
    const managerA = new VoiceProjectManager({
      storageFactory: () => storage,
      projectDirectory,
    });

    managerA.setFocusedProjectId('discord:general', 'tango');
    managerA.destroy();

    const managerB = new VoiceProjectManager({
      storageFactory: () => storage,
      projectDirectory,
    });
    expect(managerB.getFocusedProject('discord:general')).toMatchObject({
      id: 'tango',
      displayName: 'Tango MVP',
    });

    managerB.destroy();
  });

  it('prefers a topic-scoped project over the channel focus', () => {
    const manager = new VoiceProjectManager({
      storageFactory: () => createStorage(),
      projectDirectory: createDirectory(),
    });

    manager.setFocusedProjectId('discord:general', 'personal');

    expect(manager.resolveActiveProject('discord:general', {
      topicActive: true,
      topicProjectId: 'tango',
    })).toMatchObject({
      id: 'tango',
      displayName: 'Tango MVP',
    });

    manager.destroy();
  });

  it('does not leak the focused project into an active standalone topic', () => {
    const manager = new VoiceProjectManager({
      storageFactory: () => createStorage(),
      projectDirectory: createDirectory(),
    });

    manager.setFocusedProjectId('discord:general', 'personal');

    expect(manager.resolveActiveProject('discord:general', {
      topicActive: true,
      topicProjectId: null,
    })).toBeNull();
    expect(manager.resolveActiveProject('discord:general')).toMatchObject({
      id: 'personal',
      displayName: 'Personal',
    });

    manager.destroy();
  });
});
