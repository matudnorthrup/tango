import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import { VoiceTargetDirectory, isStrongAddressMatch } from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-voice-ollama-primary-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  return dir;
}

function writeAgent(dir: string, fileName: string, lines: string[]): void {
  fs.writeFileSync(path.join(dir, "agents", fileName), `${lines.join("\n")}\n`);
}

describe("Ollama-primary call-sign scheme", () => {
  function buildPairDirectory(options?: { dispatchDefault?: string }): VoiceTargetDirectory {
    const dir = createConfigDir();
    writeAgent(dir, "dispatch.yaml", [
      "id: dispatch",
      "type: router",
      "display_name: Tango",
      "provider:",
      "  default: claude-oauth",
      "voice:",
      "  call_signs:",
      "    - Tango",
      ...(options?.dispatchDefault ? [`  default_prompt_agent: ${options.dispatchDefault}`] : [])
    ]);
    writeAgent(dir, "watson.yaml", [
      "id: watson",
      "type: personal",
      "display_name: Watson",
      "provider:",
      "  default: claude-oauth",
      "voice:",
      "  call_signs:",
      '    - "Zulu Watson"'
    ]);
    writeAgent(dir, "watson-ollama.yaml", [
      "id: watson-ollama",
      "type: personal",
      "display_name: Watson (Ollama)",
      "provider:",
      "  default: ollama",
      "voice:",
      "  call_signs:",
      '    - "Bravo Watson"',
      "    - Watson"
    ]);
    return new VoiceTargetDirectory(dir);
  }

  it("routes the bare name and hey/hello greetings to the clone", () => {
    const directory = buildPairDirectory();
    for (const transcript of [
      "Watson, status update",
      "watson",
      "hello Watson, status update",
      "hey watson what's up"
    ]) {
      expect(directory.resolveExplicitAddress(transcript)).toMatchObject({
        agent: { id: "watson-ollama" }
      });
    }
  });

  it("routes Bravo forms to the clone, including Whisper comma variants", () => {
    const directory = buildPairDirectory();
    expect(directory.resolveExplicitAddress("Bravo Watson, status")).toMatchObject({
      agent: { id: "watson-ollama" },
      matchedName: "Bravo Watson"
    });
    expect(directory.resolveExplicitAddress("bravo, watson status")).toMatchObject({
      agent: { id: "watson-ollama" },
      matchedName: "Bravo Watson"
    });
  });

  it("routes Zulu forms to the original, including greeting and comma variants", () => {
    const directory = buildPairDirectory();
    for (const transcript of [
      "Zulu Watson, status",
      "zulu, watson, status",
      "hello Zulu Watson, status"
    ]) {
      expect(directory.resolveExplicitAddress(transcript)).toMatchObject({
        agent: { id: "watson" },
        matchedName: "Zulu Watson"
      });
    }
  });

  it("keeps Zulu forms strong addresses that survive cross-agent downgrade checks", () => {
    expect(isStrongAddressMatch("Zulu Watson", "zulu watson check the queue")).toBe(true);
    expect(isStrongAddressMatch("Zulu Watson", "zulu, watson,")).toBe(true);
  });

  it("leaves the Tango system call sign untouched", () => {
    const directory = buildPairDirectory();
    expect(directory.resolveExplicitAddress("Tango, settings")).toMatchObject({
      kind: "system",
      agent: { id: "dispatch" }
    });
  });

  it("prefers the configured default prompt agent", () => {
    const directory = buildPairDirectory({ dispatchDefault: "watson-ollama" });
    expect(directory.resolveDefaultPromptAgent(null)?.id).toBe("watson-ollama");
  });

  it("falls back to watson-ollama before watson when no default is configured", () => {
    const directory = buildPairDirectory();
    expect(directory.resolveDefaultPromptAgent(null)?.id).toBe("watson-ollama");
  });
});

describe("shipped repo config call-sign matrix", () => {
  interface RepoAgent {
    id: string;
    type?: string;
    callSigns: string[];
  }

  function loadRepoAgents(): RepoAgent[] {
    const agentsDir = path.join(repoRoot, "config/v2/agents");
    const agents: RepoAgent[] = [];
    for (const fileName of fs.readdirSync(agentsDir)) {
      if (!fileName.endsWith(".yaml")) continue;
      const parsed = yaml.load(
        fs.readFileSync(path.join(agentsDir, fileName), "utf8")
      ) as { id: string; type?: string; voice?: { call_signs?: string[] } };
      const callSigns = parsed.voice?.call_signs ?? [];
      if (callSigns.length === 0) continue;
      agents.push({ id: parsed.id, type: parsed.type, callSigns });
    }
    return agents;
  }

  function buildRepoDirectory(): VoiceTargetDirectory {
    // Rebuild the live address book from the real repo call signs. The live
    // profile overlay only flips `enabled` and channel ids — call signs come
    // from these repo files — so this exercises the shipped routing data
    // with the production matcher regardless of repo-side enabled flags.
    const dir = createConfigDir();
    const dispatch = yaml.load(
      fs.readFileSync(path.join(repoRoot, "config/defaults/agents/dispatch.yaml"), "utf8")
    ) as { voice?: { call_signs?: string[]; default_prompt_agent?: string } };
    writeAgent(dir, "dispatch.yaml", [
      "id: dispatch",
      "type: router",
      "display_name: Tango",
      "provider:",
      "  default: claude-oauth",
      "voice:",
      "  call_signs:",
      ...(dispatch.voice?.call_signs ?? []).map((sign) => `    - ${JSON.stringify(sign)}`),
      ...(dispatch.voice?.default_prompt_agent
        ? [`  default_prompt_agent: ${dispatch.voice.default_prompt_agent}`]
        : [])
    ]);
    for (const agent of loadRepoAgents()) {
      writeAgent(dir, `${agent.id}.yaml`, [
        `id: ${agent.id}`,
        `type: ${agent.type ?? "personal"}`,
        "provider:",
        "  default: claude-oauth",
        "voice:",
        "  call_signs:",
        ...agent.callSigns.map((sign) => `    - ${JSON.stringify(sign)}`)
      ]);
    }
    return new VoiceTargetDirectory(dir);
  }

  const PAIRED_NAMES = [
    "Watson",
    "Sierra",
    "Malibu",
    "Victor",
    "Charlie",
    "Foxtrot",
    "Juliet",
    "Porter"
  ];

  it("routes every wake form of every clone pair to the intended agent", () => {
    const directory = buildRepoDirectory();
    for (const name of PAIRED_NAMES) {
      const clone = `${name.toLowerCase()}-ollama`;
      const original = name.toLowerCase();
      const expectations: Array<[string, string]> = [
        [`${name}, status update`, clone],
        [`hello ${name}, status update`, clone],
        [`hey ${name} what's up`, clone],
        [`Bravo ${name}, status update`, clone],
        [`bravo, ${name.toLowerCase()} status`, clone],
        [`Zulu ${name}, status update`, original],
        [`zulu, ${name.toLowerCase()}, status`, original]
      ];
      for (const [transcript, expectedAgentId] of expectations) {
        const resolved = directory.resolveExplicitAddress(transcript);
        expect(resolved?.agent.id, `"${transcript}" should reach ${expectedAgentId}`).toBe(
          expectedAgentId
        );
      }
    }
  });

  it("keeps nickname aliases on the clones", () => {
    const directory = buildRepoDirectory();
    expect(directory.resolveExplicitAddress("Malibooth, hi")?.agent.id).toBe("malibu-ollama");
    expect(directory.resolveExplicitAddress("Coach Malibu, hi")?.agent.id).toBe("malibu-ollama");
    expect(directory.resolveExplicitAddress("Brother Porter, hi")?.agent.id).toBe("porter-ollama");
  });

  it("keeps unpaired agents on their bare names", () => {
    const directory = buildRepoDirectory();
    expect(directory.resolveExplicitAddress("Kilo, balance check")?.agent.id).toBe("kilo");
    expect(directory.resolveExplicitAddress("Tango, settings")?.agent.id).toBe("dispatch");
  });

  it("defaults unaddressed speech to watson-ollama", () => {
    const directory = buildRepoDirectory();
    expect(directory.resolveDefaultPromptAgent(null)?.id).toBe("watson-ollama");
  });

  it("runs kilo on the Ollama backend (TGO-735)", () => {
    const kilo = yaml.load(
      fs.readFileSync(path.join(repoRoot, "config/v2/agents/kilo.yaml"), "utf8")
    ) as { provider?: { default?: string }; runtime?: { model?: string } };
    expect(kilo.provider?.default).toBe("ollama");
    expect(kilo.runtime?.model).toBe("deepseek-v4-pro:cloud");
  });
});
