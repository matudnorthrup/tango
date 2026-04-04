import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VoiceTargetDirectory } from '../src/services/voice-targets.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tango-voice-targets-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  return dir;
}

function writeAgent(dir: string, fileName: string, lines: string[]): void {
  fs.writeFileSync(path.join(dir, 'agents', fileName), `${lines.join('\n')}\n`);
}

describe('VoiceTargetDirectory', () => {
  it('resolves system and agent call signs separately', () => {
    const dir = createConfigDir();
    writeAgent(dir, 'dispatch.yaml', [
      'id: dispatch',
      'type: router',
      'display_name: Tango',
      'provider:',
      '  default: claude-oauth',
      'voice:',
      '  call_signs:',
      '    - Tango',
    ]);
    writeAgent(dir, 'watson.yaml', [
      'id: watson',
      'type: personal',
      'display_name: Watson',
      'provider:',
      '  default: codex',
      'voice:',
      '  call_signs:',
      '    - Watson',
    ]);

    const directory = new VoiceTargetDirectory(dir);

    expect(directory.getSystemAgent()?.id).toBe('dispatch');
    expect(directory.resolveExplicitAddress('Tango, settings')).toMatchObject({
      kind: 'system',
      agent: { id: 'dispatch' },
      matchedName: 'Tango',
      transcript: 'Tango, settings',
    });
    expect(directory.resolveExplicitAddress('Watson, add that to my list')).toMatchObject({
      kind: 'agent',
      agent: { id: 'watson' },
      matchedName: 'Watson',
      transcript: 'Watson, add that to my list',
    });
  });

  it('uses the configured default prompt agent for system-routed prompts and resolves fuzzy agent queries', () => {
    const dir = createConfigDir();
    writeAgent(dir, 'dispatch.yaml', [
      'id: dispatch',
      'type: router',
      'display_name: Tango',
      'provider:',
      '  default: claude-oauth',
      'voice:',
      '  call_signs:',
      '    - Tango',
      '  default_prompt_agent: malibu',
    ]);
    writeAgent(dir, 'watson.yaml', [
      'id: watson',
      'type: personal',
      'display_name: Watson',
      'provider:',
      '  default: codex',
      'voice:',
      '  call_signs:',
      '    - Watson',
    ]);
    writeAgent(dir, 'malibu.yaml', [
      'id: malibu',
      'type: fitness',
      'display_name: Malibu',
      'provider:',
      '  default: codex',
      'voice:',
      '  call_signs:',
      '    - Malibu',
      '    - Coach Malibu',
    ]);

    const directory = new VoiceTargetDirectory(dir);

    expect(directory.resolveDefaultPromptAgent('dispatch')?.id).toBe('malibu');
    expect(directory.resolveDefaultPromptAgent('malibu')?.id).toBe('malibu');
    expect(directory.resolveAgentQuery('coach mal')).toMatchObject({ id: 'malibu' });
    expect(directory.resolveAgentQuery('tango')).toBeNull();
    expect(directory.resolveAgentQuery('tango', { includeSystem: true })).toMatchObject({ id: 'dispatch' });
  });
});
