import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GovernanceChecker } from "../src/governance.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GovernanceChecker", () => {
  it("can check permission without writing an audit row", () => {
    const db = {
      prepare(sql: string) {
        if (sql.startsWith("SELECT access_level FROM permissions")) {
          return {
            get: () => ({ access_level: "read" }),
          };
        }

        if (sql.startsWith("SELECT p.access_level, p.group_id FROM permissions p")) {
          return {
            all: () => [],
          };
        }

        if (sql.startsWith("SELECT parent_id FROM principals")) {
          return {
            get: () => undefined,
          };
        }

        if (sql.startsWith("SELECT tool_id FROM permissions")) {
          return {
            all: () => [],
          };
        }

        if (sql.startsWith("SELECT DISTINCT p.tool_id FROM permissions p")) {
          return {
            all: () => [],
          };
        }

        if (sql.startsWith("INSERT INTO governance_log")) {
          return {
            run: vi.fn(),
          };
        }

        if (sql.startsWith("SELECT access_type FROM governance_tools")) {
          return {
            get: () => ({ access_type: "write" }),
          };
        }

        throw new Error(`Unexpected query: ${sql}`);
      },
    } as unknown as DatabaseSync;

    const checker = new GovernanceChecker(db);
    expect(checker.hasPermission("worker:recipe-librarian", "fatsecret_api", "read")).toBe(true);
    expect(checker.hasPermission("worker:recipe-librarian", "fatsecret_api", "write")).toBe(false);
  });

  it("treats audit-log failures as non-fatal for permission checks", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const db = {
      prepare(sql: string) {
        if (sql.startsWith("SELECT access_level FROM permissions")) {
          return {
            get: () => ({ access_level: "write" }),
          };
        }

        if (sql.startsWith("SELECT p.access_level, p.group_id FROM permissions p")) {
          return {
            all: () => [],
          };
        }

        if (sql.startsWith("SELECT parent_id FROM principals")) {
          return {
            get: () => undefined,
          };
        }

        if (sql.startsWith("SELECT tool_id FROM permissions")) {
          return {
            all: () => [],
          };
        }

        if (sql.startsWith("SELECT DISTINCT p.tool_id FROM permissions p")) {
          return {
            all: () => [],
          };
        }

        if (sql.startsWith("INSERT INTO governance_log")) {
          return {
            run: () => {
              throw new Error("database is locked");
            },
          };
        }

        if (sql.startsWith("SELECT access_type FROM governance_tools")) {
          return {
            get: () => ({ access_type: "write" }),
          };
        }

        throw new Error(`Unexpected query: ${sql}`);
      },
    } as unknown as DatabaseSync;

    const checker = new GovernanceChecker(db);
    expect(checker.checkPermission("worker:nutrition-logger", "fatsecret_api", "write")).toEqual({
      granted: true,
      resolvedVia: "explicit",
      accessLevel: "write",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[governance] audit log write failed for worker:nutrition-logger/fatsecret_api: database is locked",
    );
  });
});
