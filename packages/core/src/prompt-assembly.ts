/**
 * Prompt Assembly — Convention-based multi-file prompt loading.
 *
 * Assembles a full system prompt for an agent or worker by reading
 * conventional files from the agent's directory and shared root files.
 *
 * File loading order:
 *   1. <agentDir>/soul.md      (identity — who you are)
 *   2. agents/shared/AGENTS.md (shared — how to function)
 *   3. agents/shared/RULES.md  (shared — behavioral guardrails)
 *   4. agents/shared/USER.md   (shared — about the human)
 *   5. <agentDir>/knowledge.md (orchestrator domain knowledge)
 *   6. <agentDir>/workers.md   (worker dispatch rules)
 *   7. agents/tools/*.md       (tool docs loaded from tool IDs)
 *   8. prompts/tools/*.md      (optional profile-owned tool overlays)
 *   9. agents/skills/*.md      (skill docs loaded from skill IDs)
 *  10. prompts/skills/*.md     (optional profile-owned skill overlays)
 *  11. prompts/<kind>/<id>/*   (optional profile-owned agent/worker overlays)
 *
 * Missing files are silently skipped. If no files are found at all,
 * returns a minimal fallback prompt.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const TOOL_DOC_MAP: Record<string, string> = {
  agent_docs: "agent-docs",
  atlas_sql: "atlas-sql",
  browser: "browser",
  discord_manage: "discord-manage",
  exa_answer: "exa",
  exa_search: "exa",
  fatsecret_api: "fatsecret",
  nutrition_log_items: "nutrition-log-items",
  find_diesel: "travel",
  gog_calendar: "gog-calendar",
  gog_docs: "gog-docs",
  gog_docs_update_tab: "gog-docs-update-tab",
  gog_email: "gog-email",
  latitude_run: "latitude-remote",
  health_morning: "health-morning",
  health_query: "health",
  location_read: "travel",
  lunch_money: "lunch-money",
  memory_add: "memory",
  memory_reflect: "memory",
  memory_search: "memory",
  obsidian: "obsidian",
  openscad_render: "printing",
  printer_command: "printing",
  prusa_slice: "printing",
  receipt_registry: "receipt-registry",
  recipe_list: "recipe",
  recipe_read: "recipe",
  recipe_write: "recipe",
  tango_file: "tango-dev",
  tango_shell: "tango-dev",
  walmart: "walmart",
  workout_sql: "workout-sql",
  onepassword: "onepassword",
  linear: "linear",
  imessage: "imessage",
  youtube_transcript: "youtube",
  youtube_analyze: "youtube",
};

export const SKILL_DOC_MAP: Record<string, string> = {
  amazon_orders: "amazon-orders",
  daily_planning: "daily-planning",
  deep_research: "deep-research",
  email_review: "email-review",
  evening_checkin: "evening-checkin",
  health_baselines: "health-baselines",
  obsidian_note_conventions: "obsidian-note-conventions",
  printing_profile_selection: "printing-profile-selection",
  ramp_reimbursements: "ramp-reimbursements",
  receipt_logging: "receipt-logging",
  recipe_format: "recipe-format",
  sinking_fund_reconciliation: "sinking-fund-reconciliation",
  transaction_categorization: "transaction-categorization",
  chipotle_ordering: "chipotle-ordering",
  open_meteo_weather: "open-meteo-weather",
  osrm_routing: "osrm-routing",
  travel_routing: "travel-routing",
  walmart_orders: "walmart-orders",
};

/**
 * Assemble the full prompt for an agent by reading conventional files.
 *
 * @param agentDir  Absolute path to the agent's directory
 * @param options   Tool IDs, skill IDs, and optional agents root override
 * @returns         Concatenated prompt text
 */
export interface PromptAssemblyOptions {
  toolIds?: string[];
  skillIds?: string[];
  agentsRootDir?: string;
  overlayDir?: string;
  overlayRootDir?: string;
}

export type PromptSectionKind =
  | "fallback"
  | "overlay"
  | "shared"
  | "skill"
  | "tool"
  | "worker";

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
    kind: "worker",
    label: "soul",
    sections,
  });

  // ── Shared files from agents/ root ──────────────────────────────
  for (const filename of ["AGENTS.md", "RULES.md", "USER.md"]) {
    appendFileSection({
      filePath: path.join(sharedDir, filename),
      kind: "shared",
      label: filename,
      sections,
    });
  }

  // ── Optional per-agent files ────────────────────────────────────
  for (const filename of ["knowledge.md", "workers.md"]) {
    appendFileSection({
      filePath: path.join(agentDir, filename),
      kind: "worker",
      label: filename,
      sections,
    });
  }

  // ── Optional tool docs from agents/tools/ ───────────────────────
  if (options.toolIds && options.toolIds.length > 0) {
    appendMappedDocs({
      ids: options.toolIds,
      docMap: TOOL_DOC_MAP,
      docsDir: path.join(agentsRootDir, "tools"),
      overlayDocsDir: options.overlayRootDir
        ? path.join(options.overlayRootDir, "tools")
        : undefined,
      sections,
      kind: "tool",
    });
  }

  // ── Optional skill docs from agents/skills/ ─────────────────────
  if (options.skillIds && options.skillIds.length > 0) {
    appendMappedDocs({
      ids: options.skillIds,
      docMap: SKILL_DOC_MAP,
      docsDir: path.join(agentsRootDir, "skills"),
      overlayDocsDir: options.overlayRootDir
        ? path.join(options.overlayRootDir, "skills")
        : undefined,
      sections,
      kind: "skill",
    });
  }

  if (options.overlayDir) {
    appendOptionalSections({
      dir: options.overlayDir,
      filenames: ["soul.md", "persona.md", "knowledge.md", "workers.md"],
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

function appendMappedDocs(input: {
  ids?: string[];
  docMap: Record<string, string>;
  docsDir: string;
  overlayDocsDir?: string;
  sections: PromptSectionTrace[];
  kind: "skill" | "tool";
}): void {
  if (!input.ids || input.ids.length === 0) return;

  const loadedDocs = new Set<string>();

  for (const id of input.ids) {
    const docFile = input.docMap[id];
    if (!docFile || loadedDocs.has(docFile)) continue;

    loadedDocs.add(docFile);
    appendFileSection({
      filePath: path.join(input.docsDir, `${docFile}.md`),
      kind: input.kind,
      label: docFile,
      sections: input.sections,
    });

    if (input.overlayDocsDir) {
      appendFileSection({
        filePath: path.join(input.overlayDocsDir, `${docFile}.md`),
        kind: "overlay",
        label: `${input.kind}:${docFile}`,
        sections: input.sections,
      });
    }
  }
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
  const toolsDir = path.join(dir, "tools");
  const skillsDir = path.join(dir, "skills");

  if (fs.existsSync(sharedDir) && (fs.existsSync(toolsDir) || fs.existsSync(skillsDir))) {
    return true;
  }

  return ["AGENTS.md", "RULES.md", "USER.md"].some((filename) =>
    fs.existsSync(path.join(dir, filename)),
  );
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
