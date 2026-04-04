/**
 * Governance Schema — Types, DDL, and seed data for the permission system.
 *
 * Tables: principals, groups, group_members, governance_tools, permissions, governance_log
 * See docs/plans/governance-permissions.md for full design.
 */

// ============================================================
// Types
// ============================================================

export type PrincipalType = "user" | "agent" | "worker";
export type AccessLevel = "none" | "read" | "write" | "admin";
export type GovernanceLevel = "personal" | "shared" | "federation";
export type PermissionDecision = "granted" | "denied";

export interface Principal {
  id: string;
  type: PrincipalType;
  parent_id: string | null;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface Group {
  id: string;
  display_name: string | null;
  governance_level: GovernanceLevel;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface GroupMember {
  group_id: string;
  principal_id: string;
  added_by: string | null;
  created_at: string;
}

export interface GovernanceTool {
  id: string;
  domain: string | null;
  display_name: string | null;
  access_type: "read" | "write";
  description: string | null;
  created_at: string;
}

export interface Permission {
  id: number;
  principal_id: string | null;
  group_id: string | null;
  tool_id: string;
  access_level: AccessLevel;
  granted_by: string | null;
  reason: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GovernanceLogEntry {
  id: number;
  principal_id: string;
  tool_id: string;
  action: string;
  decision: PermissionDecision;
  access_level_required: string | null;
  access_level_found: string | null;
  resolved_via: string | null;
  context: string | null;
  created_at: string;
}

export interface PermissionCheckResult {
  granted: boolean;
  resolvedVia: string;
  accessLevel?: AccessLevel;
}

// ============================================================
// Access Level Utilities
// ============================================================

const ACCESS_LEVEL_ORDER: Record<AccessLevel, number> = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3,
};

export function accessLevelMeetsRequired(found: AccessLevel, required: AccessLevel): boolean {
  return ACCESS_LEVEL_ORDER[found] >= ACCESS_LEVEL_ORDER[required];
}

// ============================================================
// Schema DDL
// ============================================================

export const GOVERNANCE_DDL = `
  -- PRINCIPALS
  -- Users, agents, and workers that can be granted permissions.
  -- Hierarchy: user -> agent -> worker (permissions inherit downward)
  CREATE TABLE IF NOT EXISTS principals (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    parent_id TEXT,
    display_name TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (parent_id) REFERENCES principals(id)
  );

  CREATE INDEX IF NOT EXISTS idx_principals_type ON principals(type);
  CREATE INDEX IF NOT EXISTS idx_principals_parent ON principals(parent_id);

  -- GROUPS
  -- User-defined permission groups. Principals can belong to many.
  -- Governance level controls override hierarchy (personal > shared > federation).
  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    governance_level TEXT NOT NULL DEFAULT 'personal',
    description TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- GROUP_MEMBERS
  -- Which principals belong to which groups.
  CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    added_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (group_id, principal_id),
    FOREIGN KEY (group_id) REFERENCES groups(id),
    FOREIGN KEY (principal_id) REFERENCES principals(id)
  );

  -- GOVERNANCE_TOOLS
  -- Registry of all tools available in the system.
  CREATE TABLE IF NOT EXISTS governance_tools (
    id TEXT PRIMARY KEY,
    domain TEXT,
    display_name TEXT,
    access_type TEXT NOT NULL DEFAULT 'read',
    description TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_governance_tools_domain ON governance_tools(domain);

  -- PERMISSIONS
  -- Allowlist: principals/groups can ONLY use tools explicitly granted.
  -- Exactly one of principal_id or group_id must be set.
  CREATE TABLE IF NOT EXISTS permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    principal_id TEXT,
    group_id TEXT,
    tool_id TEXT NOT NULL,
    access_level TEXT NOT NULL,
    granted_by TEXT,
    reason TEXT,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (principal_id) REFERENCES principals(id),
    FOREIGN KEY (group_id) REFERENCES groups(id),
    FOREIGN KEY (tool_id) REFERENCES governance_tools(id),
    CHECK (
      (principal_id IS NOT NULL AND group_id IS NULL) OR
      (principal_id IS NULL AND group_id IS NOT NULL)
    )
  );

  CREATE INDEX IF NOT EXISTS idx_permissions_principal ON permissions(principal_id);
  CREATE INDEX IF NOT EXISTS idx_permissions_group ON permissions(group_id);
  CREATE INDEX IF NOT EXISTS idx_permissions_tool ON permissions(tool_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_permissions_principal_tool
    ON permissions(principal_id, tool_id) WHERE principal_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_permissions_group_tool
    ON permissions(group_id, tool_id) WHERE group_id IS NOT NULL;

  -- GOVERNANCE_LOG
  -- Audit trail of every permission check.
  CREATE TABLE IF NOT EXISTS governance_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    principal_id TEXT NOT NULL,
    tool_id TEXT NOT NULL,
    action TEXT NOT NULL,
    decision TEXT NOT NULL,
    access_level_required TEXT,
    access_level_found TEXT,
    resolved_via TEXT,
    context TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_governance_log_principal ON governance_log(principal_id);
  CREATE INDEX IF NOT EXISTS idx_governance_log_created ON governance_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_governance_log_decision ON governance_log(decision);
`;

// ============================================================
// Seed Data
// ============================================================

export const GOVERNANCE_SEED = `
  -- Principals: user -> agents -> workers
  INSERT OR IGNORE INTO principals (id, type, display_name)
    VALUES ('user:owner', 'user', 'Owner');

  INSERT OR IGNORE INTO principals (id, type, parent_id, display_name) VALUES
    ('agent:watson', 'agent', 'user:owner', 'Watson'),
    ('agent:malibu', 'agent', 'user:owner', 'Malibu'),
    ('agent:sierra', 'agent', 'user:owner', 'Sierra'),
    ('agent:dispatch', 'agent', 'user:owner', 'Tango'),
    ('agent:victor', 'agent', 'user:owner', 'Victor');

  INSERT OR IGNORE INTO principals (id, type, parent_id, display_name) VALUES
    ('worker:nutrition-logger', 'worker', 'agent:malibu', 'Nutrition Logger'),
    ('worker:health-analyst', 'worker', 'agent:malibu', 'Health Analyst'),
    ('worker:workout-recorder', 'worker', 'agent:malibu', 'Workout Recorder'),
    ('worker:recipe-librarian', 'worker', 'agent:malibu', 'Recipe Librarian'),
    ('worker:personal-assistant', 'worker', 'agent:watson', 'Personal Assistant'),
    ('worker:research-assistant', 'worker', 'agent:sierra', 'Research Assistant'),
    ('worker:dev-assistant', 'worker', 'agent:victor', 'Dev Assistant');

  -- Tools (from MCP server)
  INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
    ('fatsecret_api', 'wellness', 'FatSecret API', 'write'),
    ('health_query', 'wellness', 'Health Query', 'read'),
    ('workout_sql', 'wellness', 'Workout SQL', 'write'),
    ('atlas_sql', 'wellness', 'Atlas SQL', 'write'),
    ('recipe_list', 'wellness', 'Recipe List', 'read'),
    ('recipe_read', 'wellness', 'Recipe Read', 'read'),
    ('recipe_write', 'wellness', 'Recipe Write', 'write'),
    ('gog_email', 'personal', 'Gmail', 'write'),
    ('gog_calendar', 'personal', 'Google Calendar', 'write'),
    ('gog_docs', 'personal', 'Google Docs', 'write'),
    ('obsidian', 'personal', 'Obsidian Vault', 'write'),
    ('health_morning', 'personal', 'Health Morning Briefing', 'read'),
    ('lunch_money', 'personal', 'Lunch Money Finance', 'write'),
    ('receipt_registry', 'personal', 'Receipt Registry', 'write'),
    ('ramp_reimbursement', 'personal', 'Ramp Reimbursement Automation', 'write'),
    ('memory_search', 'shared', 'Memory Search', 'read'),
    ('memory_add', 'shared', 'Memory Add', 'write'),
    ('memory_reflect', 'shared', 'Memory Reflect', 'write'),
    ('exa_search', 'research', 'EXA Web Search', 'read'),
    ('exa_answer', 'research', 'EXA Answer', 'read'),
    ('printer_command', 'research', 'PrusaLink Printer', 'write'),
    ('openscad_render', 'research', 'OpenSCAD Render', 'write'),
    ('prusa_slice', 'research', 'PrusaSlicer', 'write'),
    ('location_read', 'research', 'GPS Location', 'read'),
    ('find_diesel', 'research', 'Diesel Finder', 'read'),
    ('walmart', 'research', 'Walmart Shopping', 'write'),
    ('browser', 'shared', 'Browser Automation', 'write'),
    ('slack', 'shared', 'Slack Workspace Read', 'read'),
    ('file_ops', 'research', 'File Operations', 'write'),
    ('agent_docs', 'tango', 'Agent Documentation', 'write'),
    ('tango_shell', 'tango', 'Tango Shell', 'write'),
    ('tango_file', 'tango', 'Tango File Editor', 'write'),
    ('discord_manage', 'tango', 'Discord Server Management', 'write'),
    ('onepassword', 'shared', '1Password Credential Retrieval', 'read'),
    ('linear', 'personal', 'Linear Project Management', 'write'),
    ('imessage', 'personal', 'iMessage Read/Send', 'write'),
    ('latitude_run', 'personal', 'Latitude Remote MCP (Notion, Slack, etc.)', 'write'),
    ('youtube_transcript', 'research', 'YouTube Transcript', 'read'),
    ('youtube_analyze', 'research', 'YouTube Video Analysis', 'read');

  -- Default groups
  INSERT OR IGNORE INTO groups (id, display_name, governance_level, description) VALUES
    ('self', 'Self', 'personal', 'Owner and their own agents'),
    ('family', 'Family', 'shared', 'Family members with limited access'),
    ('team', 'Team', 'shared', 'Work team with project-scoped access');

  -- Worker permissions (seeded from current tool assignments)
  -- nutrition-logger
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:nutrition-logger', 'fatsecret_api', 'write', 'seed from config'),
    ('worker:nutrition-logger', 'atlas_sql', 'write', 'seed from config'),
    ('worker:nutrition-logger', 'recipe_read', 'read', 'seed from config'),
    ('worker:nutrition-logger', 'health_query', 'read', 'evening checkin: TDEE for calorie budget');

  -- health-analyst
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:health-analyst', 'health_query', 'read', 'seed from config');

  -- workout-recorder
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:workout-recorder', 'workout_sql', 'write', 'seed from config');

  -- recipe-librarian
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:recipe-librarian', 'atlas_sql', 'write', 'seed from config'),
    ('worker:recipe-librarian', 'recipe_list', 'read', 'seed from config'),
    ('worker:recipe-librarian', 'recipe_read', 'read', 'seed from config'),
    ('worker:recipe-librarian', 'recipe_write', 'write', 'seed from config'),
    ('worker:recipe-librarian', 'fatsecret_api', 'write', 'seed from config');

  -- personal-assistant (Watson)
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:personal-assistant', 'gog_email', 'write', 'seed from config'),
    ('worker:personal-assistant', 'gog_calendar', 'write', 'seed from config'),
    ('worker:personal-assistant', 'gog_docs', 'write', 'seed from config'),
    ('worker:personal-assistant', 'obsidian', 'write', 'seed from config'),
    ('worker:personal-assistant', 'health_morning', 'read', 'seed from config'),
    ('worker:personal-assistant', 'lunch_money', 'write', 'seed from config'),
    ('worker:personal-assistant', 'receipt_registry', 'write', 'seed from config'),
    ('worker:personal-assistant', 'ramp_reimbursement', 'write', 'seed from config'),
    ('worker:personal-assistant', 'agent_docs', 'write', 'seed from config'),
    ('worker:personal-assistant', 'slack', 'read', 'seed from config'),
    ('worker:personal-assistant', 'linear', 'write', 'seed from config'),
    ('worker:personal-assistant', 'imessage', 'write', 'seed from config'),
    ('worker:personal-assistant', 'latitude_run', 'write', 'seed from config');

  -- research-assistant (Sierra)
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:research-assistant', 'exa_search', 'read', 'seed from config'),
    ('worker:research-assistant', 'exa_answer', 'read', 'seed from config'),
    ('worker:research-assistant', 'printer_command', 'write', 'seed from config'),
    ('worker:research-assistant', 'openscad_render', 'write', 'seed from config'),
    ('worker:research-assistant', 'prusa_slice', 'write', 'seed from config'),
    ('worker:research-assistant', 'obsidian', 'write', 'travel planning + research filing'),
    ('worker:research-assistant', 'location_read', 'read', 'travel navigation'),
    ('worker:research-assistant', 'find_diesel', 'read', 'travel navigation'),
    ('worker:research-assistant', 'walmart', 'write', 'walmart shopping and queue management'),
    ('worker:research-assistant', 'browser', 'write', 'web automation for shopping and research'),
    ('worker:research-assistant', 'slack', 'read', 'seed from config'),
    ('worker:research-assistant', 'file_ops', 'write', 'file access for Downloads, 3d-printing, Documents'),
    ('worker:research-assistant', 'youtube_transcript', 'read', 'YouTube transcript extraction'),
    ('worker:research-assistant', 'youtube_analyze', 'read', 'YouTube video analysis via Gemini');

  -- personal-assistant browser access (Watson — receipt lookup, transaction categorization)
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:personal-assistant', 'browser', 'write', 'web automation for receipt lookup and transaction categorization');

  -- 1Password access — Watson (personal assistant) needs credentials for finance, shopping, services
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:personal-assistant', 'onepassword', 'read', 'credential retrieval for service logins and API keys');

  -- 1Password access — Sierra (research assistant) needs credentials for shopping sites
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:research-assistant', 'onepassword', 'read', 'credential retrieval for shopping and service logins');

  -- dev-assistant (Victor) — uses built-in Claude tools for dev work, MCP for Discord + tango management
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:dev-assistant', 'discord_manage', 'write', 'seed from config'),
    ('worker:dev-assistant', 'tango_shell', 'write', 'seed from config'),
    ('worker:dev-assistant', 'tango_file', 'write', 'seed from config');

  -- Universal memory tools available to all agents/workers via inheritance from the owner
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('user:owner', 'memory_search', 'read', 'universal memory retrieval'),
    ('user:owner', 'memory_add', 'write', 'universal memory storage'),
    ('user:owner', 'memory_reflect', 'write', 'universal memory reflection');
`;
