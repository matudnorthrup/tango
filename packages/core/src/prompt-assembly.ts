/**
 * Prompt Assembly — Convention-based multi-file prompt loading.
 *
 * Assembles a full system prompt by reading conventional files from the
 * agent's directory and shared root files.
 *
 * File loading order:
 *   1. <agentDir>/soul.md      (identity — who you are)
 *   2. agents/shared/RULES.md  (shared — behavioral guardrails)
 *   3. agents/shared/USER.md   (shared — about the human)
 *   4. <agentDir>/knowledge.md (domain knowledge)
 *   5. prompts/<kind>/<id>/*   (optional profile-owned prompt overlays)
 *
 * Missing files are silently skipped. If no files are found at all,
 * returns a minimal fallback prompt.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { expandHomePath } from "./runtime-paths.js";

/**
 * Assemble the full prompt for an agent by reading conventional files.
 *
 * @param agentDir  Absolute path to the agent's directory
 * @param options   Optional agents root override and prompt overlay directory
 * @returns         Concatenated prompt text
 */
export interface PromptAssemblyOptions {
  agentsRootDir?: string;
  overlayDir?: string;
}

export interface SoulPromptConfig {
  systemPromptFile: string;
}

export interface SoulPromptAssemblyOptions {
  repoRoot?: string;
  overlayDir?: string;
}

export type PromptSectionKind =
  | "fallback"
  | "overlay"
  | "shared"
  | "base";

export interface PromptSectionTrace {
  kind: PromptSectionKind;
  label: string;
  sourcePath: string;
  content: string;
}

export interface PromptTrace {
  text: string;
  sections: PromptSectionTrace[];
}

export function assembleAgentPrompt(
  agentDir: string,
  options: PromptAssemblyOptions = {},
): string {
  return traceAgentPrompt(agentDir, options).text;
}

export function assembleSoulPrompt(
  config: SoulPromptConfig,
  options: SoulPromptAssemblyOptions = {},
): string {
  const promptFile = resolveSystemPromptFile(config.systemPromptFile, options.repoRoot);
  if (!fs.existsSync(promptFile)) {
    throw new Error(`System prompt file not found: ${promptFile}`);
  }

  if (path.basename(promptFile) !== "soul.md") {
    const prompt = readIfExists(promptFile);
    if (!prompt) {
      throw new Error(`System prompt file is empty: ${promptFile}`);
    }
    return prompt;
  }

  return assembleAgentPrompt(path.dirname(promptFile), {
    overlayDir: options.overlayDir,
  });
}

export function traceAgentPrompt(
  agentDir: string,
  options: PromptAssemblyOptions = {},
): PromptTrace {
  const agentsRootDir = options.agentsRootDir ?? findAgentsRoot(agentDir);
  const sharedDir = fs.existsSync(path.join(agentsRootDir, "shared"))
    ? path.join(agentsRootDir, "shared")
    : agentsRootDir;
  const sections: PromptSectionTrace[] = [];

  // ── Identity first (soul) ───────────────────────────────────────
  appendFileSection({
    filePath: path.join(agentDir, "soul.md"),
    kind: "base",
    label: "soul.md",
    sections,
  });

  // ── Shared files from agents/ root ──────────────────────────────
  for (const filename of ["RULES.md", "USER.md"]) {
    appendFileSection({
      filePath: path.join(sharedDir, filename),
      kind: "shared",
      label: filename,
      sections,
    });
  }

  // ── Optional per-agent files ────────────────────────────────────
  for (const filename of ["knowledge.md"]) {
    appendFileSection({
      filePath: path.join(agentDir, filename),
      kind: "base",
      label: filename,
      sections,
    });
  }

  if (options.overlayDir) {
    appendOptionalSections({
      dir: options.overlayDir,
      filenames: ["soul.md", "persona.md", "knowledge.md"],
      sections,
      kind: "overlay",
    });
  }

  if (sections.length === 0) {
    const agentId = path.basename(agentDir);
    const fallback = `You are the ${agentId} agent. Execute the task using your available tools.`;
    return {
      text: fallback,
      sections: [
        {
          kind: "fallback",
          label: "fallback",
          sourcePath: `generated:${agentId}`,
          content: fallback,
        },
      ],
    };
  }

  return {
    text: sections.map((section) => section.content).join("\n\n"),
    sections,
  };
}

function appendOptionalSections(input: {
  dir: string;
  filenames: string[];
  sections: PromptSectionTrace[];
  kind: "overlay";
}): void {
  for (const filename of input.filenames) {
    appendFileSection({
      filePath: path.join(input.dir, filename),
      kind: input.kind,
      label: filename,
      sections: input.sections,
    });
  }
}

function appendFileSection(input: {
  filePath: string;
  kind: PromptSectionKind;
  label: string;
  sections: PromptSectionTrace[];
}): void {
  const content = readIfExists(input.filePath);
  if (!content) {
    return;
  }

  input.sections.push({
    kind: input.kind,
    label: input.label,
    sourcePath: input.filePath,
    content,
  });
}

function findAgentsRoot(agentDir: string): string {
  let current = path.resolve(agentDir);

  while (true) {
    if (path.basename(current) === "agents" || looksLikeAgentsRoot(current)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) return path.dirname(path.resolve(agentDir));
    current = parent;
  }
}

function looksLikeAgentsRoot(dir: string): boolean {
  const sharedDir = path.join(dir, "shared");
  if (fs.existsSync(sharedDir)) {
    return true;
  }

  return ["RULES.md", "USER.md"].some((filename) =>
    fs.existsSync(path.join(dir, filename)),
  );
}

function resolveSystemPromptFile(systemPromptFile: string, repoRoot?: string): string {
  const trimmed = systemPromptFile.trim();
  if (!trimmed) {
    throw new Error("systemPromptFile must be a non-empty path.");
  }

  const expanded = expandHomePath(trimmed);
  return path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(repoRoot ?? process.cwd(), expanded);
}

function readIfExists(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, "utf8").trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}
