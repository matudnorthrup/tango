/**
 * Tango Agent Tools — Internal tools for agent self-management.
 *
 * Tools:
 *   - agent_docs: Read/write agent documentation files (soul.md, knowledge.md, tool docs, skill docs, etc.)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@tango/core";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export interface TangoToolPaths {
  agentsDir?: string;
}

function resolvePaths(overrides?: TangoToolPaths) {
  return {
    agentsDir: overrides?.agentsDir ?? path.resolve("agents"),
  };
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
        "File conventions:",
        "  Shared: shared/AGENTS.md, shared/RULES.md, shared/USER.md",
        "  Assistants: assistants/<id>/{soul,knowledge,workers}.md",
        "  Workers: workers/<id>/soul.md",
        "  System: system/<id>/soul.md",
        "  Shared tool docs: agents/tools/*.md",
        "  Shared skills: agents/skills/*.md",
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

          return { files: mdFiles, directories: dirs };
        }

        if (operation === "read") {
          const relPath = String(input.path ?? "");
          const resolved = validatePath(agentsDir, relPath);
          if (!resolved) return { error: "Invalid path — must be a .md file within agents/" };

          if (!fs.existsSync(resolved)) {
            return { error: `File not found: ${relPath}` };
          }
          return { content: fs.readFileSync(resolved, "utf8") };
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
