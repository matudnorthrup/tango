/**
 * Tango Agent Tools — Internal tools for agent self-management.
 *
 * Tools:
 *   - agent_docs: Read/write agent documentation files (soul.md, knowledge.md, tool docs, skill docs, etc.)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  resolveTangoProfileAgentsDir,
  resolveTangoProfileSharedPromptLookupDirs,
  type TangoProfilePathOptions,
} from "@tango/core";
import type { AgentTool } from "@tango/core";
import {
  resolveTangoProfileSkillPromptsDir,
  resolveTangoProfileToolPromptsDir,
} from "@tango/core";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export interface TangoToolPaths {
  agentsDir?: string;
  profileAgentsDir?: string;
  profileSharedDirs?: string[];
  profilePathOptions?: TangoProfilePathOptions;
  /** Override the profile skills overlay dir (tests). */
  profileSkillsDir?: string;
  /** Override the profile tools overlay dir (tests). */
  profileToolsDir?: string;
}

const SHARED_DOC_NAMES = new Set(["RULES.md", "USER.md", "AGENTS.md"]);
const AGENT_TREE_PREFIXES = new Set(["assistants", "workers", "system"]);

function resolvePaths(overrides?: TangoToolPaths) {
  const profilePathOptions = overrides?.profilePathOptions;
  return {
    agentsDir: overrides?.agentsDir ?? path.resolve("agents"),
    profileAgentsDir:
      overrides?.profileAgentsDir
      ?? resolveTangoProfileAgentsDir(profilePathOptions),
    profileSharedDirs:
      overrides?.profileSharedDirs
      ?? resolveTangoProfileSharedPromptLookupDirs(profilePathOptions),
    profileSkillsDir: overrides?.profileSkillsDir ?? resolveTangoProfileSkillPromptsDir(),
    profileToolsDir: overrides?.profileToolsDir ?? resolveTangoProfileToolPromptsDir(),
  };
}

function normalizeRelativePath(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\/+/, "");
}

function parseSharedDocRelativePath(relPath: string): string | null {
  const normalized = normalizeRelativePath(relPath);
  const match = normalized.match(/^shared\/(.+\.md)$/);
  if (!match?.[1]) return null;
  const filename = path.basename(match[1]);
  return SHARED_DOC_NAMES.has(filename) ? filename : null;
}

function isAgentTreeRelativePath(relPath: string): boolean {
  const first = normalizeRelativePath(relPath).split("/")[0];
  return AGENT_TREE_PREFIXES.has(first ?? "");
}

function profileLayerNote(source: "profile" | "repo", kind: "shared" | "agent"): string {
  if (source === "profile" && kind === "shared") {
    return "Shared docs load from the Tango profile layer, not the repo template.";
  }
  if (source === "repo" && kind === "shared") {
    return "Repo template only. On profile installs, edit ~/.tango/profiles/<profile>/agents/shared/ instead.";
  }
  if (source === "profile" && kind === "agent") {
    return "Agent docs load from the profile layer (~/.tango/profiles/<profile>/agents/).";
  }
  return "Repo template only. On profile installs, edit the matching path under ~/.tango/profiles/<profile>/agents/.";
}

function resolveSharedDocPath(
  agentsDir: string,
  relPath: string,
  profileSharedDirs: string[],
): { repoPath: string; effectivePath: string; source: "profile" | "repo" } | null {
  const filename = parseSharedDocRelativePath(relPath);
  if (!filename) return null;

  const repoPath = path.resolve(agentsDir, "shared", filename);
  for (const profileDir of profileSharedDirs) {
    const profilePath = path.join(profileDir, filename);
    if (fs.existsSync(profilePath)) {
      return { repoPath, effectivePath: profilePath, source: "profile" };
    }
  }

  return { repoPath, effectivePath: repoPath, source: "repo" };
}

function resolveSharedDocWritePath(
  agentsDir: string,
  relPath: string,
  profileSharedDirs: string[],
): { effectivePath: string; source: "profile" | "repo" } | null {
  const filename = parseSharedDocRelativePath(relPath);
  if (!filename) return null;

  const preferredProfileDir = profileSharedDirs[0];
  if (preferredProfileDir) {
    return {
      effectivePath: path.join(preferredProfileDir, filename),
      source: "profile",
    };
  }

  return {
    effectivePath: path.resolve(agentsDir, "shared", filename),
    source: "repo",
  };
}

function resolveAgentTreeDocPath(
  agentsDir: string,
  profileAgentsDir: string | undefined,
  relPath: string,
  mode: "read" | "write",
): { repoPath: string; effectivePath: string; source: "profile" | "repo" } | null {
  if (!isAgentTreeRelativePath(relPath)) return null;

  const normalized = normalizeRelativePath(relPath);
  const repoPath = path.resolve(agentsDir, normalized);
  if (!repoPath.startsWith(path.resolve(agentsDir))) return null;
  if (!normalized.endsWith(".md")) return null;

  if (profileAgentsDir) {
    const profilePath = path.resolve(profileAgentsDir, normalized);
    if (!profilePath.startsWith(path.resolve(profileAgentsDir))) return null;

    if (mode === "write" || fs.existsSync(profilePath)) {
      return {
        repoPath,
        effectivePath: profilePath,
        source: "profile",
      };
    }
  }

  return { repoPath, effectivePath: repoPath, source: "repo" };
}

function resolveAgentTreeDirectoryPath(
  agentsDir: string,
  profileAgentsDir: string | undefined,
  relPath: string,
): { effectivePath: string; source: "profile" | "repo" } | null {
  if (!relPath) return null;

  const normalized = normalizeRelativePath(relPath);
  if (!isAgentTreeRelativePath(normalized)) {
    return validateDirectoryPath(agentsDir, normalized)
      ? { effectivePath: path.resolve(agentsDir, normalized), source: "repo" }
      : null;
  }

  const repoPath = path.resolve(agentsDir, normalized);
  if (!repoPath.startsWith(path.resolve(agentsDir))) return null;

  if (profileAgentsDir) {
    const profilePath = path.resolve(profileAgentsDir, normalized);
    if (profilePath.startsWith(path.resolve(profileAgentsDir)) && fs.existsSync(profilePath)) {
      return { effectivePath: profilePath, source: "profile" };
    }
  }

  if (fs.existsSync(repoPath)) {
    return { effectivePath: repoPath, source: "repo" };
  }

  return null;
}

function resolveAgentDirectory(
  agentsDir: string,
  profileAgentsDir: string | undefined,
  agentId: string,
): string | null {
  const candidates = [
    path.join("assistants", agentId),
    path.join("workers", agentId),
    path.join("system", agentId),
    agentId,
  ];

  if (profileAgentsDir) {
    for (const candidate of candidates) {
      const resolved = path.resolve(profileAgentsDir, candidate);
      if (fs.existsSync(resolved)) return resolved;
    }
  }

  for (const candidate of candidates) {
    const resolved = path.resolve(agentsDir, candidate);
    if (fs.existsSync(resolved)) return resolved;
  }

  return null;
}

function resolveDocPath(
  paths: ReturnType<typeof resolvePaths>,
  relPath: string,
  mode: "read" | "write",
): {
  effectivePath: string;
  source: "profile" | "repo";
  kind: "shared" | "agent" | "repo";
} | null {
  const sharedDoc = mode === "write"
    ? resolveSharedDocWritePath(paths.agentsDir, relPath, paths.profileSharedDirs)
    : resolveSharedDocPath(paths.agentsDir, relPath, paths.profileSharedDirs);

  if (sharedDoc) {
    return {
      effectivePath: sharedDoc.effectivePath,
      source: sharedDoc.source,
      kind: "shared",
    };
  }

  const agentDoc = resolveAgentTreeDocPath(
    paths.agentsDir,
    paths.profileAgentsDir,
    relPath,
    mode,
  );
  if (agentDoc) {
    return {
      effectivePath: agentDoc.effectivePath,
      source: agentDoc.source,
      kind: "agent",
    };
  }

  const repoPath = validatePath(paths.agentsDir, relPath);
  if (!repoPath) return null;

  return { effectivePath: repoPath, source: "repo", kind: "repo" };
}

function docResultMeta(
  source: "profile" | "repo",
  kind: "shared" | "agent" | "repo",
  resolvedPath: string,
): Record<string, string> {
  if (kind === "repo") {
    return {};
  }

  return {
    source,
    path: resolvedPath,
    note: profileLayerNote(source, kind),
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
        "Profile layer (operator installs): profile wins over repo for shared/ and assistants|workers|system/.",
        "",
        "Operations:",
        "  list — List files in a directory",
        "    { \"operation\": \"list\", \"path\": \"assistants/watson\" }",
        "    { \"operation\": \"list\", \"agent\": \"watson\" }",
        "",
        "  read — Read a file",
        "    { \"operation\": \"read\", \"path\": \"assistants/watson/knowledge.md\" }",
        "    { \"operation\": \"read\", \"path\": \"shared/USER.md\" }",
        "",
        "  write — Write/overwrite a file (creates if missing)",
        "    { \"operation\": \"write\", \"path\": \"assistants/watson/knowledge.md\", \"content\": \"...\" }",
        "",
        "  patch — Replace a specific string in a file",
        "    { \"operation\": \"patch\", \"path\": \"assistants/watson/knowledge.md\", \"old\": \"...\", \"new\": \"...\" }",
        "",
        "File conventions:",
        "  Shared (all agents): shared/AGENTS.md, shared/RULES.md, shared/USER.md — profile shared/ wins",
        "  Per-agent: assistants/<id>/{soul,knowledge,USER,RULES,workers}.md — profile assistants/<id>/ wins",
        "  Workers: workers/<id>/soul.md; System: system/<id>/soul.md",
        "  Per-agent RULES add to shared RULES; per-agent USER overrides shared USER (same as prompt assembly)",
        "  Repo tools/skills: agents/tools/*.md, agents/skills/*.md",
        "",
        "Repo skill/tool docs are GENERIC defaults shared by all installs. Reading",
        "tools/<x>.md or skills/<x>.md automatically appends your profile overlay",
        "(~/.tango/profiles/<profile>/prompts/{tools,skills}/<x>.md) when present.",
        "Keep personal/installation-specific details (real accounts, IDs, private",
        "preferences) OUT of repo docs — put them in the profile overlay file so the",
        "repo stays shareable. See docs/guides/profile-model.md.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["list", "read", "write", "patch"],
            description: "Operation to perform",
          },
          path: {
            type: "string",
            description: "Relative path within agents/ (e.g. 'assistants/watson/knowledge.md', 'tools/atlas-sql.md')",
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
        },
        required: ["operation"],
      },
      handler: async (input) => {
        const operation = String(input.operation);
        const agentsDir = paths.agentsDir;

        if (operation === "list") {
          const relPath = input.path ? String(input.path) : "";
          const agentId = input.agent ? String(input.agent) : "";

          let resolved: string | null = null;
          if (relPath) {
            resolved = resolveAgentTreeDirectoryPath(
              agentsDir,
              paths.profileAgentsDir,
              relPath,
            )?.effectivePath ?? null;
          } else if (agentId) {
            resolved = resolveAgentDirectory(agentsDir, paths.profileAgentsDir, agentId);
          } else {
            resolved = path.resolve(agentsDir);
          }

          if (!resolved) {
            return { error: "Invalid path — list target must stay within agents/" };
          }
          if (!fs.existsSync(resolved)) {
            return { error: `Directory not found: ${agentId || relPath || "/"}` };
          }

          const entries = fs.readdirSync(resolved);
          const mdFiles = entries.filter((e) => e.endsWith(".md"));
          const dirs = entries.filter((e) => {
            try {
              return fs.statSync(path.join(resolved!, e)).isDirectory();
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
          const resolvedDoc = resolveDocPath(paths, relPath, "read");
          if (!resolvedDoc) {
            return { error: "Invalid path — must be a .md file within agents/" };
          }

          const overlayPath = resolveDocOverlayPath(relPath, paths);
          const overlay = readDocOverlay(overlayPath);
          const baseExists = fs.existsSync(resolvedDoc.effectivePath);
          if (!baseExists && overlay === null) {
            return { error: `File not found: ${relPath}` };
          }

          const baseContent = baseExists
            ? fs.readFileSync(resolvedDoc.effectivePath, "utf8")
            : "";
          let content = baseContent;
          if (overlay) {
            const overlayName = overlayPath ? path.basename(overlayPath) : "overlay";
            content = baseContent.trim().length > 0
              ? `${baseContent.replace(/\s+$/u, "")}\n\n<!-- profile overlay: ${overlayName} -->\n\n${overlay}\n`
              : `${overlay}\n`;
          }

          return {
            content,
            ...docResultMeta(
              resolvedDoc.source,
              resolvedDoc.kind,
              resolvedDoc.effectivePath,
            ),
          };
        }

        if (operation === "write") {
          const relPath = String(input.path ?? "");
          const content = String(input.content ?? "");
          const resolvedDoc = resolveDocPath(paths, relPath, "write");
          if (!resolvedDoc) {
            return { error: "Invalid path — must be a .md file within agents/" };
          }

          const dir = path.dirname(resolvedDoc.effectivePath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(resolvedDoc.effectivePath, content, "utf8");
          return {
            success: true,
            path: relPath,
            ...(resolvedDoc.source === "profile"
              ? {
                  written_to: "profile",
                  resolved_path: resolvedDoc.effectivePath,
                }
              : {}),
          };
        }

        if (operation === "patch") {
          const relPath = String(input.path ?? "");
          const oldText = String(input.old ?? "");
          const newText = String(input.new ?? "");
          const resolvedDoc = resolveDocPath(paths, relPath, "read");
          if (!resolvedDoc) {
            return { error: "Invalid path — must be a .md file within agents/" };
          }

          if (!fs.existsSync(resolvedDoc.effectivePath)) {
            return { error: `File not found: ${relPath}` };
          }

          const current = fs.readFileSync(resolvedDoc.effectivePath, "utf8");
          if (!current.includes(oldText)) {
            return { error: "Old text not found in file" };
          }

          const writeTarget = resolveDocPath(paths, relPath, "write");
          const targetPath = writeTarget?.effectivePath ?? resolvedDoc.effectivePath;
          const updated = current.replace(oldText, newText);
          fs.writeFileSync(targetPath, updated, "utf8");
          return {
            success: true,
            path: relPath,
            ...(writeTarget?.source === "profile"
              ? { written_to: "profile", resolved_path: targetPath }
              : {}),
          };
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
