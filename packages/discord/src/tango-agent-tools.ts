/**
 * Tango Agent Tools — Internal tools for agent self-management.
 *
 * Tools:
 *   - agent_docs: Read/write agent documentation files (soul.md, knowledge.md, tool docs, skill docs, etc.)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@tango/core";
import {
  resolveTangoProfileDir,
  resolveTangoProfileSkillPromptsDir,
  resolveTangoProfileToolPromptsDir,
} from "@tango/core";
import {
  PROFILE_STATE_BODY_NAMESPACES,
  normalizeProfileStateBodyDirectoryPath,
  normalizeProfileStateBodyPath,
  resolveProfileStateBodyDirectoryPath,
  resolveProfileStateBodyPath,
} from "./state-body-provider.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export interface TangoToolPaths {
  agentsDir?: string;
  /** Override the profile skills overlay dir (tests). */
  profileSkillsDir?: string;
  /** Override the profile tools overlay dir (tests). */
  profileToolsDir?: string;
  /** Override the profile root for state body docs (tests). */
  profileStateRoot?: string;
}

function resolvePaths(overrides?: TangoToolPaths) {
  return {
    agentsDir: overrides?.agentsDir ?? path.resolve("agents"),
    profileSkillsDir: overrides?.profileSkillsDir ?? resolveTangoProfileSkillPromptsDir(),
    profileToolsDir: overrides?.profileToolsDir ?? resolveTangoProfileToolPromptsDir(),
    profileStateRoot: overrides?.profileStateRoot ?? resolveTangoProfileDir(),
  };
}

// ---------------------------------------------------------------------------
// Profile overlay resolution for shared skills/tools docs
//
// Repo `agents/skills/<x>.md` and `agents/tools/<x>.md` are GENERIC defaults.
// Installation-specific additions (real accounts, personal preferences, private
// knowledge) live in the profile overlay at
// `~/.tango/profiles/<profile>/prompts/{skills,tools}/<x>.md`. On read, the
// overlay is appended to the generic base so an agent sees both, while the repo
// stays free of personal data. See docs/guides/profile-model.md.
// ---------------------------------------------------------------------------

/**
 * Map a repo-relative agent-docs path to its profile overlay file, if the path
 * is a shared skill or tool doc. Returns null for anything else (e.g. persona
 * files, which are overlaid at prompt-assembly time instead).
 */
function resolveDocOverlayPath(
  relPath: string,
  overlayDirs: { profileSkillsDir: string; profileToolsDir: string },
): string | null {
  const normalized = relPath.replace(/\\/gu, "/").replace(/^\.\//u, "");
  const skillMatch = /^(?:agents\/)?skills\/([^/]+\.md)$/u.exec(normalized);
  if (skillMatch?.[1]) {
    return path.join(overlayDirs.profileSkillsDir, skillMatch[1]);
  }
  const toolMatch = /^(?:agents\/)?tools\/([^/]+\.md)$/u.exec(normalized);
  if (toolMatch?.[1]) {
    return path.join(overlayDirs.profileToolsDir, toolMatch[1]);
  }
  return null;
}

function readDocOverlay(overlayPath: string | null): string | null {
  if (!overlayPath) return null;
  try {
    if (!fs.existsSync(overlayPath)) return null;
    const content = fs.readFileSync(overlayPath, "utf8").trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Agent docs tool
// ---------------------------------------------------------------------------

export function createTangoTools(overrides?: TangoToolPaths): AgentTool[] {
  const paths = resolvePaths(overrides);

  return [
    {
      name: "agent_docs",
      description: [
        "Read, write, and list agent documentation files. Use this for self-healing —",
        "when you discover a mistake or missing knowledge, update the relevant doc so",
        "future sessions get it right.",
        "",
        "Scoped to the agents/ directory only. Allowed files: *.md",
        "",
        "Operations:",
        "  list — List files in a directory",
        "    { \"operation\": \"list\", \"path\": \"assistants/watson\" }",
        "    { \"operation\": \"list\", \"agent\": \"watson\" }",
        "",
        "  read — Read a file",
        "    { \"operation\": \"read\", \"path\": \"assistants/watson/knowledge.md\" }",
        "    { \"operation\": \"read\", \"path\": \"shared/AGENTS.md\" }",
        "    { \"operation\": \"read\", \"path\": \"tools/atlas-sql.md\" }",
        "",
        "  write — Write/overwrite a file (creates if missing)",
        "    { \"operation\": \"write\", \"path\": \"assistants/watson/knowledge.md\", \"content\": \"# Watson Domain Knowledge\\n...\" }",
        "",
        "  patch — Replace a specific string in a file",
        "    { \"operation\": \"patch\", \"path\": \"assistants/watson/knowledge.md\", \"old\": \"old text\", \"new\": \"new text\" }",
        "",
        "  state_list / state_read / state_write / state_patch — profile state files",
        "    { \"operation\": \"state_list\", \"path\": \"threads\" }",
        "    { \"operation\": \"state_read\", \"path\": \"threads/launch.md\" }",
        "    { \"operation\": \"state_write\", \"path\": \"threads/launch.md\", \"content\": \"...\" }",
        "    { \"operation\": \"state_patch\", \"path\": \"threads/launch.md\", \"old\": \"old\", \"new\": \"new\" }",
        "",
        "File conventions:",
        "  Shared: shared/AGENTS.md, shared/RULES.md, shared/USER.md",
        "  Assistants: assistants/<id>/{soul,knowledge,workers}.md",
        "  Workers: workers/<id>/soul.md",
        "  System: system/<id>/soul.md",
        "  Shared tool docs: agents/tools/*.md",
        "  Shared skills: agents/skills/*.md",
        "",
        "Repo skill/tool docs are GENERIC defaults shared by all installs. Reading",
        "tools/<x>.md or skills/<x>.md automatically appends your profile overlay",
        "(~/.tango/profiles/<profile>/prompts/{tools,skills}/<x>.md) when present.",
        "Keep personal/installation-specific details (real accounts, IDs, private",
        "preferences) OUT of repo docs — put them in the profile overlay file so the",
        "repo stays shareable. See docs/guides/profile-model.md.",
        "",
        "Profile state files are private markdown bodies for ongoing threads/projects.",
        `They are limited to: ${PROFILE_STATE_BODY_NAMESPACES.join(", ")}.`,
        "The tool rejects path traversal, absolute paths, non-markdown files, and",
        "symlink escapes. Mutating source_kind: source|reference files requires force.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["list", "read", "write", "patch", "state_list", "state_read", "state_write", "state_patch"],
            description: "Operation to perform",
          },
          path: {
            type: "string",
            description: "Relative path within agents/ or profile state namespace (e.g. 'assistants/watson/knowledge.md', 'tools/atlas-sql.md', 'threads/launch.md')",
          },
          agent: {
            type: "string",
            description: "Agent ID for list operation (e.g. 'watson', 'research-assistant')",
          },
          content: {
            type: "string",
            description: "File content for write operation",
          },
          old: {
            type: "string",
            description: "Text to find for patch operation",
          },
          new: {
            type: "string",
            description: "Replacement text for patch operation",
          },
          force: {
            type: "boolean",
            description: "Allow state_write/state_patch on source_kind: source|reference files.",
          },
        },
        required: ["operation"],
      },
      handler: async (input) => {
        const operation = String(input.operation);
        const agentsDir = paths.agentsDir;

        if (operation.startsWith("state_")) {
          return handleStateDocsOperation(operation, input, paths.profileStateRoot);
        }

        if (operation === "list") {
          const relPath = input.path ? String(input.path) : "";
          const agentId = input.agent ? String(input.agent) : "";
          const targetDir = relPath
            ? validateDirectoryPath(agentsDir, relPath)
            : agentId
              ? resolveAgentDirectory(agentsDir, agentId)
              : path.resolve(agentsDir);
          if (!targetDir) {
            return { error: "Invalid path — list target must stay within agents/" };
          }
          const resolved = path.resolve(targetDir);

          if (!resolved.startsWith(path.resolve(agentsDir))) {
            return { error: "Path escapes agents/ directory" };
          }
          if (!fs.existsSync(resolved)) {
            return { error: `Directory not found: ${agentId || "/"}` };
          }

          const entries = fs.readdirSync(resolved);
          const mdFiles = entries.filter((e) => e.endsWith(".md"));
          const dirs = entries.filter((e) => {
            try {
              return fs.statSync(path.join(resolved, e)).isDirectory();
            } catch {
              return false;
            }
          });

          // Surface profile-overlay-only skill/tool docs alongside repo files.
          const listedDir = path.basename(resolved);
          const overlayDir = listedDir === "skills"
            ? paths.profileSkillsDir
            : listedDir === "tools"
              ? paths.profileToolsDir
              : null;
          if (overlayDir) {
            try {
              for (const entry of fs.readdirSync(overlayDir)) {
                if (entry.endsWith(".md") && !mdFiles.includes(entry)) {
                  mdFiles.push(entry);
                }
              }
              mdFiles.sort((a, b) => a.localeCompare(b));
            } catch {
              // No overlay dir — repo listing is complete.
            }
          }

          return { files: mdFiles, directories: dirs };
        }

        if (operation === "read") {
          const relPath = String(input.path ?? "");
          const resolved = validatePath(agentsDir, relPath);
          if (!resolved) return { error: "Invalid path — must be a .md file within agents/" };

          // Shared skill/tool docs may carry an installation-specific profile
          // overlay; append it to the generic repo base so the agent sees both.
          const overlayPath = resolveDocOverlayPath(relPath, paths);
          const overlay = readDocOverlay(overlayPath);
          const baseExists = fs.existsSync(resolved);
          if (!baseExists && overlay === null) {
            return { error: `File not found: ${relPath}` };
          }

          const baseContent = baseExists ? fs.readFileSync(resolved, "utf8") : "";
          if (!overlay) {
            return { content: baseContent };
          }
          const overlayName = overlayPath ? path.basename(overlayPath) : "overlay";
          const content = baseContent.trim().length > 0
            ? `${baseContent.replace(/\s+$/u, "")}\n\n<!-- profile overlay: ${overlayName} -->\n\n${overlay}\n`
            : `${overlay}\n`;
          return { content };
        }

        if (operation === "write") {
          const relPath = String(input.path ?? "");
          const content = String(input.content ?? "");
          const resolved = validatePath(agentsDir, relPath);
          if (!resolved) return { error: "Invalid path — must be a .md file within agents/" };

          const dir = path.dirname(resolved);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(resolved, content, "utf8");
          return { success: true, path: relPath };
        }

        if (operation === "patch") {
          const relPath = String(input.path ?? "");
          const oldText = String(input.old ?? "");
          const newText = String(input.new ?? "");
          const resolved = validatePath(agentsDir, relPath);
          if (!resolved) return { error: "Invalid path — must be a .md file within agents/" };

          if (!fs.existsSync(resolved)) {
            return { error: `File not found: ${relPath}` };
          }
          const current = fs.readFileSync(resolved, "utf8");
          if (!current.includes(oldText)) {
            return { error: "Old text not found in file" };
          }
          const updated = current.replace(oldText, newText);
          fs.writeFileSync(resolved, updated, "utf8");
          return { success: true, path: relPath };
        }

        return { error: `Unknown operation: ${operation}` };
      },
    },
  ];
}

/**
 * Validate and resolve a relative path within agents/.
 * Returns null if the path is invalid (escapes directory or not .md).
 */
function validatePath(agentsDir: string, relPath: string): string | null {
  if (!relPath || relPath.includes("..")) return null;

  const resolved = path.resolve(agentsDir, relPath);
  if (!resolved.startsWith(path.resolve(agentsDir))) return null;
  if (!resolved.endsWith(".md")) return null;

  return resolved;
}

function validateDirectoryPath(agentsDir: string, relPath: string): string | null {
  if (!relPath || relPath.includes("..")) return null;

  const resolved = path.resolve(agentsDir, relPath);
  if (!resolved.startsWith(path.resolve(agentsDir))) return null;

  return resolved;
}

function resolveAgentDirectory(agentsDir: string, agentId: string): string | null {
  const candidates = [
    path.join("assistants", agentId),
    path.join("workers", agentId),
    path.join("system", agentId),
    agentId,
  ];

  for (const candidate of candidates) {
    const resolved = path.resolve(agentsDir, candidate);
    if (fs.existsSync(resolved)) return resolved;
  }

  return null;
}

function handleStateDocsOperation(
  operation: string,
  input: Record<string, unknown>,
  profileStateRoot: string,
): Record<string, unknown> {
  try {
    if (operation === "state_list") {
      return listStateDocs(String(input.path ?? ""), profileStateRoot);
    }

    if (operation === "state_read") {
      const relPath = normalizeProfileStateBodyPath(String(input.path ?? ""));
      const filePath = resolveProfileStateBodyPath(relPath, { profileRoot: profileStateRoot });
      if (!fs.existsSync(filePath)) {
        return { error: `State file not found: profile:${relPath}` };
      }
      return {
        content: fs.readFileSync(filePath, "utf8"),
        path: `profile:${relPath}`,
        layer: "profile",
      };
    }

    if (operation === "state_write") {
      const relPath = normalizeProfileStateBodyPath(String(input.path ?? ""));
      const content = String(input.content ?? "");
      const filePath = resolveProfileStateBodyPath(relPath, { profileRoot: profileStateRoot });
      const guard = guardStateMutation(filePath, input.force === true);
      if (guard) return { error: guard };
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, "utf8");
      return { success: true, path: `profile:${relPath}`, layer: "profile" };
    }

    if (operation === "state_patch") {
      const relPath = normalizeProfileStateBodyPath(String(input.path ?? ""));
      const oldText = String(input.old ?? "");
      const newText = String(input.new ?? "");
      const filePath = resolveProfileStateBodyPath(relPath, { profileRoot: profileStateRoot });
      if (!fs.existsSync(filePath)) {
        return { error: `State file not found: profile:${relPath}` };
      }
      const guard = guardStateMutation(filePath, input.force === true);
      if (guard) return { error: guard };
      const current = fs.readFileSync(filePath, "utf8");
      if (!current.includes(oldText)) {
        return { error: "Old text not found in state file" };
      }
      fs.writeFileSync(filePath, current.replace(oldText, newText), "utf8");
      return { success: true, path: `profile:${relPath}`, layer: "profile" };
    }

    return { error: `Unknown state operation: ${operation}` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function listStateDocs(relPathInput: string, profileStateRoot: string): Record<string, unknown> {
  const relPath = normalizeProfileStateBodyDirectoryPath(relPathInput);
  if (!relPath) {
    return {
      path: "profile:",
      layer: "profile",
      directories: [...PROFILE_STATE_BODY_NAMESPACES],
      files: [],
    };
  }

  const dirPath = resolveProfileStateBodyDirectoryPath(relPath, { profileRoot: profileStateRoot });
  if (!fs.existsSync(dirPath)) {
    return { error: `State directory not found: profile:${relPath}` };
  }
  if (!fs.statSync(dirPath).isDirectory()) {
    return { error: `State path is not a directory: profile:${relPath}` };
  }

  const entries = fs.readdirSync(dirPath);
  const files = entries.filter((entry) => {
    try {
      return entry.endsWith(".md") && fs.statSync(path.join(dirPath, entry)).isFile();
    } catch {
      return false;
    }
  }).sort((a, b) => a.localeCompare(b));
  const directories = entries.filter((entry) => {
    try {
      return fs.statSync(path.join(dirPath, entry)).isDirectory();
    } catch {
      return false;
    }
  }).sort((a, b) => a.localeCompare(b));

  return {
    path: `profile:${relPath}`,
    layer: "profile",
    files,
    directories,
  };
}

function guardStateMutation(filePath: string, force: boolean): string | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const sourceKind = readSourceKind(fs.readFileSync(filePath, "utf8"));
  if ((sourceKind === "source" || sourceKind === "reference") && !force) {
    return `Refusing to modify profile state file with source_kind: ${sourceKind}; pass force=true only when explicitly intended.`;
  }
  return null;
}

function readSourceKind(content: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content);
  if (!match) return null;
  const sourceKind = /^source_kind:\s*["']?([^"'\r\n#]+)["']?\s*(?:#.*)?$/imu.exec(match[1] ?? "");
  return sourceKind?.[1]?.trim().toLowerCase() ?? null;
}
