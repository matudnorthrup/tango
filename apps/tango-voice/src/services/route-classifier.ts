import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { resolve } from 'node:path';
import { TangoStorage } from '@tango/core';
import type { ChannelRouter } from './channel-router.js';
import type { VoiceTopicManager } from './voice-topics.js';
import type { VoiceProjectManager } from './voice-projects.js';
import type { VoiceAddressAgent } from '@tango/voice';
import { quickCompletion } from './claude.js';
import { resolveSharedTangoConfigPath, resolveSharedTangoDbPath } from './shared-storage.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RouteTarget {
  id: string;
  type: 'thread' | 'topic' | 'channel' | 'forum';
  name: string;
  parent?: string;
  recencyLabel?: 'active-today' | 'recent' | 'stale' | 'very-stale';
  lastActiveAt?: string;
}

export interface RouteClassifierResult {
  action: 'route' | 'create' | 'none';
  target?: string;
  targetName?: string;
  targetType?: RouteTarget['type'];
  recencyLabel?: RouteTarget['recencyLabel'];
  confidence: number;
  createTitle?: string;
  mentionsAnyTargetName?: boolean;
  targetMentionedInTranscript?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLASSIFIER_TIMEOUT_MS = 3000;
const CLASSIFIER_MAX_TOKENS = 100;
const HIGH_CONFIDENCE = 0.85;
const MEDIUM_CONFIDENCE = 0.60;

const TARGET_CACHE_TTL_MS = 60_000; // 1 minute
const DAY_MS = 24 * 60 * 60 * 1000;
export const CREATION_INTENT_PATTERN = /\b(create|make|start|open|new)\b[\s\S]{0,30}\b(thread|post|topic|conversation|discussion)\b/i;

export interface RouteClassifierDatabase {
  prepare(sql: string): {
    all(...params: string[]): Array<{
      discordChannelId?: string | null;
      discord_channel_id?: string | null;
      lastActive?: string | null;
      last_active?: string | null;
    }>;
  };
}

export interface RouteClassifierBuildOptions {
  db?: RouteClassifierDatabase;
  now?: Date;
}

// ---------------------------------------------------------------------------
// Routing rules (config-driven hints)
// ---------------------------------------------------------------------------

interface RoutingRule {
  keywords: string[];
  target_hint: string;
  agent?: string;
}

let loadedRules: RoutingRule[] | null = null;

function loadRoutingRules(): RoutingRule[] {
  if (loadedRules !== null) return loadedRules;

  const configPath = resolve(resolveSharedTangoConfigPath(), 'routing-rules.yaml');

  try {
    const raw = readFileSync(configPath, 'utf-8');
    // Simple YAML parse for our flat structure — avoids adding a YAML dependency.
    // Format: rules: [{keywords: [...], target_hint: "...", agent: "..."}]
    const rules: RoutingRule[] = [];
    let currentRule: Partial<RoutingRule> | null = null;

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- keywords:')) {
        if (currentRule?.keywords && currentRule.target_hint) {
          rules.push(currentRule as RoutingRule);
        }
        currentRule = { keywords: [] };
        // Parse inline array: ["a", "b", "c"]
        const match = trimmed.match(/\[([^\]]*)\]/);
        if (match) {
          currentRule.keywords = match[1]
            .split(',')
            .map((s) => s.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean);
        }
      } else if (trimmed.startsWith('target_hint:') && currentRule) {
        currentRule.target_hint = trimmed.slice('target_hint:'.length).trim().replace(/^["']|["']$/g, '');
      } else if (trimmed.startsWith('agent:') && currentRule) {
        currentRule.agent = trimmed.slice('agent:'.length).trim().replace(/^["']|["']$/g, '');
      }
    }
    if (currentRule?.keywords && currentRule.target_hint) {
      rules.push(currentRule as RoutingRule);
    }

    loadedRules = rules;
    if (rules.length > 0) {
      console.log(`Route classifier: loaded ${rules.length} routing rules from config`);
    }
    return rules;
  } catch {
    loadedRules = [];
    return [];
  }
}

function buildRoutingRulesHint(rules: RoutingRule[]): string {
  if (rules.length === 0) return '';

  const hints = rules.map((r) => {
    const kw = r.keywords.join(', ');
    return `- Keywords [${kw}] suggest "${r.target_hint}"`;
  }).join('\n');

  return `\nRouting hints (use as guidance, not hard rules):\n${hints}\n`;
}

// ---------------------------------------------------------------------------
// Target inventory cache
// ---------------------------------------------------------------------------

let cachedTargets: RouteTarget[] | null = null;
let cachedTargetsAt = 0;
let routeClassifierStorage: TangoStorage | null = null;

function isVitestRuntime(): boolean {
  return Boolean(
    process.env.VITEST ||
      process.env.VITEST_POOL_ID ||
      process.argv.some((arg) => arg.toLowerCase().includes('vitest')),
  );
}

function getRouteClassifierDatabase(): RouteClassifierDatabase {
  if (!routeClassifierStorage) {
    const dbPath = isVitestRuntime()
      ? resolveSharedTangoDbPath(resolve(
          os.tmpdir(),
          `tango-voice-route-classifier-${process.pid}-${randomUUID()}.sqlite`,
        ))
      : resolveSharedTangoDbPath();
    routeClassifierStorage = new TangoStorage(dbPath);
  }

  return routeClassifierStorage.getDatabase();
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function hasCreationIntent(transcript: string): boolean {
  return CREATION_INTENT_PATTERN.test(transcript);
}

export function normalizeRouteTargetName(name: string): string {
  return name.toLowerCase().replace(/\s*\(.*\)$/, '').trim();
}

export function promptMentionsRouteTargetName(
  strippedPrompt: string,
  targetName: string | null | undefined,
): boolean {
  const normalizedTargetName = targetName ? normalizeRouteTargetName(targetName) : '';
  if (!normalizedTargetName) return false;
  return strippedPrompt.toLowerCase().includes(normalizedTargetName);
}

export function promptMentionsAnyRouteTargetName(
  strippedPrompt: string,
  targets: RouteTarget[],
): boolean {
  const normalizedPrompt = strippedPrompt.toLowerCase();
  return targets.some((target) => {
    const normalizedName = normalizeRouteTargetName(target.name);
    return normalizedName.length > 0 && normalizedPrompt.includes(normalizedName);
  });
}

function parseSqliteTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const withTimezone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized)
    ? normalized
    : `${normalized}Z`;
  const parsed = new Date(withTimezone);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getInactiveDays(lastActiveAt: string | undefined, now: Date): number | null {
  const lastActive = parseSqliteTimestamp(lastActiveAt);
  if (!lastActive) return null;
  const ageMs = Math.max(0, now.getTime() - lastActive.getTime());
  return Math.floor(ageMs / DAY_MS);
}

function resolveRecencyLabel(
  lastActiveAt: string | undefined,
  now: Date,
): RouteTarget['recencyLabel'] {
  const lastActive = parseSqliteTimestamp(lastActiveAt);
  if (!lastActive) return 'very-stale';

  const ageMs = Math.max(0, now.getTime() - lastActive.getTime());
  if (ageMs < DAY_MS) return 'active-today';
  if (ageMs < 3 * DAY_MS) return 'recent';
  if (ageMs <= 7 * DAY_MS) return 'stale';
  return 'very-stale';
}

function formatRecencyNote(target: RouteTarget, now: Date): string {
  if (!target.recencyLabel) return '';

  if (target.recencyLabel === 'active-today') {
    return ' (active today)';
  }

  const inactiveDays = getInactiveDays(target.lastActiveAt, now);
  if (inactiveDays === null) {
    return target.recencyLabel === 'very-stale'
      ? ' (very stale - no inbound activity)'
      : ` (${target.recencyLabel.replace('-', ' ')})`;
  }

  const dayLabel = inactiveDays === 1 ? 'day' : 'days';
  return ` (${target.recencyLabel.replace('-', ' ')} - ${inactiveDays} ${dayLabel} inactive)`;
}

export async function annotateTargetsWithRecency(
  targets: RouteTarget[],
  db: RouteClassifierDatabase,
  now = new Date(),
): Promise<RouteTarget[]> {
  const routableTargetIds = targets
    .filter((target) => target.type === 'thread' || target.type === 'topic')
    .map((target) => target.id);

  if (routableTargetIds.length === 0) {
    return targets;
  }

  const placeholders = routableTargetIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `
        SELECT discord_channel_id AS discordChannelId, MAX(created_at) AS lastActive
        FROM messages
        WHERE direction = 'inbound'
          AND discord_channel_id IN (${placeholders})
        GROUP BY discord_channel_id
      `,
    )
    .all(...routableTargetIds);

  const lastActiveByChannelId = new Map<string, string>();
  for (const row of rows) {
    const channelId = row.discordChannelId ?? row.discord_channel_id ?? null;
    const lastActive = row.lastActive ?? row.last_active ?? null;
    if (channelId && lastActive) {
      lastActiveByChannelId.set(channelId, lastActive);
    }
  }

  return targets.map((target) => {
    if (target.type !== 'thread' && target.type !== 'topic') {
      return target;
    }

    const lastActiveAt = lastActiveByChannelId.get(target.id);
    return {
      ...target,
      lastActiveAt,
      recencyLabel: resolveRecencyLabel(lastActiveAt, now),
    };
  });
}

// ---------------------------------------------------------------------------
// Build target inventory
// ---------------------------------------------------------------------------

/**
 * Gathers routing targets from forum threads and voice topics.
 * Agent default channels are deliberately excluded — they are the fallback,
 * not candidates for content-based routing.
 */
export async function buildRouteTargetInventory(
  router: ChannelRouter,
  topicManager: VoiceTopicManager,
  projectManager: VoiceProjectManager,
  agents: VoiceAddressAgent[],
  options?: RouteClassifierBuildOptions,
): Promise<RouteTarget[]> {
  const useCache = !options?.db && !options?.now;
  const now = Date.now();
  if (useCache && cachedTargets && now - cachedTargetsAt < TARGET_CACHE_TTL_MS) {
    return cachedTargets;
  }

  // Collect agent default channel IDs to exclude them from candidates
  const agentDefaultChannelIds = new Set<string>();
  for (const agent of agents) {
    if (agent.defaultChannelId) {
      agentDefaultChannelIds.add(agent.defaultChannelId);
    }
  }

  const targets: RouteTarget[] = [];

  // 1. Active forum threads (Discord API)
  try {
    const threads = await router.getForumThreads();
    for (const thread of threads) {
      if (agentDefaultChannelIds.has(thread.threadId)) continue;
      targets.push({
        id: thread.threadId,
        type: 'thread',
        name: thread.displayName,
      });
    }
  } catch (err: any) {
    console.warn(`Route classifier: failed to fetch forum threads: ${err.message}`);
  }

  // 2. Active voice topics — topics that are currently focused in any channel
  // We expose topics that have been used, so the classifier can suggest them
  // even if they're not currently focused.
  // (VoiceTopicManager doesn't expose a listAll; we rely on forum threads
  //  and project context instead.)

  // 3. Forum channels as creation containers
  try {
    const forums = router.listForumChannels();
    for (const forum of forums) {
      targets.push({
        id: forum.id,
        type: 'forum',
        name: `${forum.name} (forum)`,
      });
    }
  } catch (err: any) {
    console.warn(`Route classifier: failed to list forum channels: ${err.message}`);
  }

  // 4. Agent default channels as creation containers
  for (const agent of agents) {
    if (agent.defaultChannelId) {
      targets.push({
        id: agent.defaultChannelId,
        type: 'channel',
        name: `${agent.displayName ?? agent.id} (agent channel)`,
        parent: agent.id,
      });
    }
  }

  // 5. Non-default channels from the router
  // Skip agent-named channels (watson, malibu, sierra, default) since
  // those are agent home channels and serve as the fallback.
  const channelList = router.listChannels();
  for (const ch of channelList) {
    if (ch.name === 'default') continue;
    if (agents.some((a) => a.id === ch.name)) continue;
    targets.push({
      id: ch.name,
      type: 'channel',
      name: ch.displayName,
    });
  }

  let annotatedTargets = targets;
  try {
    annotatedTargets = await annotateTargetsWithRecency(
      targets,
      options?.db ?? getRouteClassifierDatabase(),
      options?.now ?? new Date(),
    );
  } catch (err: any) {
    console.warn(`Route classifier: failed to annotate target recency: ${err.message}`);
  }

  if (useCache) {
    cachedTargets = annotatedTargets;
    cachedTargetsAt = now;
  }

  return annotatedTargets;
}

/**
 * Force-clear the target inventory cache (e.g., after channel switch or thread creation).
 */
export function invalidateRouteTargetCache(): void {
  cachedTargets = null;
  cachedTargetsAt = 0;
}

// ---------------------------------------------------------------------------
// Classifier prompt
// ---------------------------------------------------------------------------

function buildClassifierPrompt(
  targets: RouteTarget[],
  currentChannel: string,
  currentTopic: string | null,
  options?: {
    preferNoneForShortGeneric?: boolean;
    now?: Date;
  },
): string {
  const promptNow = options?.now ?? new Date();
  const routingTargets = targets.filter((t) => t.type === 'thread' || t.type === 'topic');
  const creationTargets = targets.filter((t) => t.type === 'forum' || t.type === 'channel');

  const routingList = routingTargets.map((t) => {
    const parent = t.parent ? ` (in ${t.parent})` : '';
    return `- [${t.type}] id="${t.id}" name="${t.name}"${parent}${formatRecencyNote(t, promptNow)}`;
  }).join('\n');

  const creationList = creationTargets.map((t) => {
    return `- [${t.type}] id="${t.id}" name="${t.name}"`;
  }).join('\n');

  const rules = loadRoutingRules();
  const rulesHint = buildRoutingRulesHint(rules);

  return [
    'Given a voice transcript, determine if it references an existing conversation target or wants to create a new one.',
    '',
    'Existing targets (for routing):',
    routingList || '(none)',
    '',
    'Creation containers (for new threads/posts):',
    creationList || '(none)',
    rulesHint,
    `Current context: ${currentChannel}${currentTopic ? `, topic: ${currentTopic}` : ', no active topic'}`,
    '',
    'Respond with ONLY a raw JSON object. No markdown fences, no explanation, no text before or after the JSON.',
    '{"action":"route"|"create"|"none","target":"<targetId>","confidence":0.0-1.0,"title":"<short title if create>"}',
    '',
    'Rules:',
    '- "route": transcript references an existing target by name or topic.',
    '- "create": ONLY when the user uses an explicit creation verb like "create a thread", "make a post", "start a new thread/post/topic". Extract a concise title. Set target to the best-fit creation container.',
    '- "none": no routing or creation intent detected.',
    '- IMPORTANT: Talking about something new or mentioning a topic that relates to a forum is NOT creation intent. "Create" requires an explicit verb (create/make/start) paired with a noun (thread/post/topic/conversation). Never infer creation from topic novelty alone.',
    '- Stale targets (>3 days inactive): require the user to explicitly mention the thread name or topic. Do not route to stale targets based on loose topical similarity alone.',
    '- Very stale targets (>7 days inactive): NEVER suggest routing to these unless the user explicitly names them. Set action to "none" for very stale targets.',
    options?.preferNoneForShortGeneric
      ? 'IMPORTANT: The user\'s input is short/generic and does not mention any specific thread or topic by name. Strongly prefer action: "none". Only suggest routing if there is an unmistakable topical match with confidence > 0.95.'
      : '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main classifier entry point
// ---------------------------------------------------------------------------

/**
 * Runs the route classifier against the given transcript.
 * Returns a classification result with confidence scores.
 *
 * Safe to call on every prompt — returns { action: 'none' } quickly when
 * there are no routing targets or the prompt has no routing signal.
 */
export async function inferRouteTarget(
  strippedPrompt: string,
  router: ChannelRouter,
  topicManager: VoiceTopicManager,
  projectManager: VoiceProjectManager,
  agents: VoiceAddressAgent[],
  options?: RouteClassifierBuildOptions,
): Promise<RouteClassifierResult> {
  const noRoute: RouteClassifierResult = { action: 'none', confidence: 0 };

  // Short prompts rarely contain routing signals
  const wordCount = countWords(strippedPrompt);
  if (wordCount < 3) return noRoute;

  const targets = await buildRouteTargetInventory(
    router,
    topicManager,
    projectManager,
    agents,
    options,
  );
  if (targets.length === 0) return noRoute;

  const activeChannel = router.getActiveChannel();
  const currentTopic = topicManager.getFocusedTopic(activeChannel.name)?.title ?? null;
  const mentionsAnyTargetName = promptMentionsAnyRouteTargetName(strippedPrompt, targets);

  const systemPrompt = buildClassifierPrompt(
    targets,
    activeChannel.name,
    currentTopic,
    {
      preferNoneForShortGeneric: !mentionsAnyTargetName && wordCount < 10,
      now: options?.now,
    },
  );

  const userMessage = JSON.stringify({ transcript: strippedPrompt });

  let raw = '';
  try {
    const signal = AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS);
    raw = await quickCompletion(systemPrompt, userMessage, CLASSIFIER_MAX_TOKENS, signal, 'haiku', '{');
  } catch (err: any) {
    const msg = err.message ?? '';
    const isTimeout = msg.includes('timeout') || msg.includes('aborted') || err.name === 'TimeoutError';
    if (isTimeout) {
      console.warn('Route classifier timed out');
    } else {
      console.warn(`Route classifier failed: ${msg}`);
    }
    return noRoute;
  }

  // Parse JSON response
  const parsed = extractJson(raw);
  if (!parsed) {
    console.warn(`Route classifier returned unparseable response: "${raw}"`);
    return noRoute;
  }

  const action = String(parsed.action ?? 'none').trim().toLowerCase();
  const confidence = Number(parsed.confidence);
  const targetId = String(parsed.target ?? '').trim();

  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return noRoute;
  }

  if (action === 'create' && !hasCreationIntent(strippedPrompt)) {
    console.log(
      `Route classifier: downgraded create action to none — no creation verb found in transcript`,
    );
    return { action: 'none', confidence, mentionsAnyTargetName };
  }

  if (action === 'create') {
    const title = String(parsed.title ?? '').trim();
    if (!title || !targetId) {
      console.warn(`Route classifier: create action missing title or target`);
      return noRoute;
    }
    const matchedTarget = targets.find((t) => t.id === targetId);
    if (!matchedTarget) {
      console.warn(`Route classifier: create suggested unknown target: "${targetId}"`);
      return noRoute;
    }
    console.log(
      `Route classifier: create "${title}" in ${matchedTarget.type} "${matchedTarget.name}" (confidence: ${confidence.toFixed(2)})`,
    );
    return {
      action: 'create',
      target: matchedTarget.id,
      targetName: matchedTarget.name,
      targetType: matchedTarget.type,
      recencyLabel: matchedTarget.recencyLabel,
      confidence,
      createTitle: title,
      mentionsAnyTargetName,
      targetMentionedInTranscript: promptMentionsRouteTargetName(strippedPrompt, matchedTarget.name),
    };
  }

  if (action !== 'route' || !targetId) {
    return { action: 'none', confidence, mentionsAnyTargetName };
  }

  // Validate that the target exists in our inventory
  const matchedTarget = targets.find((t) => t.id === targetId);
  if (!matchedTarget) {
    console.warn(`Route classifier suggested unknown target: "${targetId}"`);
    return noRoute;
  }

  console.log(
    `Route classifier: ${matchedTarget.type} "${matchedTarget.name}" (confidence: ${confidence.toFixed(2)})`,
  );

  return {
    action: 'route',
    target: matchedTarget.id,
    targetName: matchedTarget.name,
    targetType: matchedTarget.type,
    recencyLabel: matchedTarget.recencyLabel,
    confidence,
    mentionsAnyTargetName,
    targetMentionedInTranscript: promptMentionsRouteTargetName(strippedPrompt, matchedTarget.name),
  };
}

// ---------------------------------------------------------------------------
// Confidence helpers
// ---------------------------------------------------------------------------

export function isHighConfidence(result: RouteClassifierResult): boolean {
  return result.action === 'route' && result.confidence > HIGH_CONFIDENCE;
}

export function isMediumConfidence(result: RouteClassifierResult): boolean {
  return (
    result.action === 'route' &&
    result.confidence >= MEDIUM_CONFIDENCE &&
    result.confidence <= HIGH_CONFIDENCE
  );
}

const HIGH_CREATE_CONFIDENCE = 0.90;
const MEDIUM_CREATE_CONFIDENCE = 0.80;

export function isHighCreateConfidence(result: RouteClassifierResult): boolean {
  return result.action === 'create' && result.confidence > HIGH_CREATE_CONFIDENCE;
}

export function isMediumCreateConfidence(result: RouteClassifierResult): boolean {
  return (
    result.action === 'create' &&
    result.confidence >= MEDIUM_CREATE_CONFIDENCE &&
    result.confidence <= HIGH_CREATE_CONFIDENCE
  );
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function extractJson(raw: string): any | null {
  const text = raw.trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    // Try extracting JSON object from surrounding text
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}
