/**
 * Link a conversation (Discord channel/thread) to a project state file.
 *
 * Creates or updates a project_state "head" (Unified Memory System, Slice 1) so
 * the agent in that conversation gets the per-turn state-file pointer and a
 * project-aware reseed after rotation.
 *
 * Usage:
 *   node --import tsx scripts/link-project-state.ts \
 *     --key thread:<threadId>            # or channel:<channelId>
 *     --path "Italy Motorcycle Trip June 2026.md"   # vault-relative .md
 *     [--title "Italy Motorcycle Trip"] [--status planning] \
 *     [--quick-read "June route locked; [redacted] flight open."] [--agent sierra]
 *
 * The conversationKey is `thread:{threadId}` when the conversation is a Discord
 * thread/forum post, else `channel:{channelId}` — the same key TangoRouter uses.
 * The body is the canonical narrative; the head is the recall index/pointer.
 */
import { resolveDatabasePath, TangoStorage } from "@tango/core";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

const key = arg("key");
const obsidianPath = arg("path");
if (!key || !obsidianPath) {
  console.error(
    "required: --key <thread:ID|channel:ID> --path <vault-relative.md> "
    + "[--title T] [--status S] [--quick-read Q] [--agent A]",
  );
  process.exit(1);
}

const storage = new TangoStorage(resolveDatabasePath(process.env.TANGO_DB_PATH));
const record = storage.upsertProjectState({
  projectId: key,
  obsidianPath,
  ...(arg("title") ? { title: arg("title")! } : {}),
  ...(arg("status") ? { status: arg("status")! } : {}),
  ...(arg("quick-read") ? { quickRead: arg("quick-read")! } : {}),
  ...(arg("agent") ? { leadAgentId: arg("agent")! } : {}),
});
console.log("Linked project_state head:");
console.log(JSON.stringify(record, null, 2));
storage.close();
