/**
 * Diagnostic script: lists all channels/threads/forum posts visible to the
 * route classifier, showing archive status so you can verify filtering works.
 *
 * Usage:  npx tsx apps/tango-voice/src/testing/list-routing-targets.ts
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, GatewayIntentBits, ChannelType, type ForumChannel } from 'discord.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const token = process.env['DISCORD_TOKEN'];
const guildId = process.env['DISCORD_GUILD_ID'];
if (!token || !guildId) {
  console.error('Missing DISCORD_TOKEN or DISCORD_GUILD_ID');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

async function main() {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Login timeout')), 15_000);
    client.once('clientReady', () => { clearTimeout(timeout); resolve(); });
    client.login(token).catch((err) => { clearTimeout(timeout); reject(err); });
  });

  const guild = client.guilds.cache.get(guildId!) ?? await client.guilds.fetch(guildId!);
  console.log(`Connected to guild: ${guild.name}\n`);

  // --- Forum threads ---
  const forums = guild.channels.cache.filter(
    (ch): ch is ForumChannel => ch.type === ChannelType.GuildForum,
  );

  console.log('=== Forum Threads (fetchActive per forum) ===');
  for (const forum of forums.values()) {
    const active = await forum.threads.fetchActive();
    if (active.threads.size === 0) continue;
    console.log(`\n  Forum: #${forum.name}`);
    for (const thread of active.threads.values()) {
      const status = thread.archived ? 'ARCHIVED' : 'active';
      const age = thread.lastMessageId
        ? `last msg ${timeSince(snowflakeToDate(thread.lastMessageId))} ago`
        : 'no messages';
      console.log(`    [${status}] ${thread.name}  (id: ${thread.id}, ${age})`);
    }
  }

  // --- Guild active threads ---
  console.log('\n=== Guild Active Threads (fetchActiveThreads) ===');
  const activeThreads = await guild.channels.fetchActiveThreads();
  for (const thread of activeThreads.threads.values()) {
    const parentName = thread.parent?.name ?? 'unknown';
    const status = thread.archived ? 'ARCHIVED' : 'active';
    const age = thread.lastMessageId
      ? `last msg ${timeSince(snowflakeToDate(thread.lastMessageId))} ago`
      : 'no messages';

    // Check who sent the last message
    let lastAuthor = '';
    try {
      const msgs = await thread.messages.fetch({ limit: 1 });
      const lastMsg = msgs.first();
      if (lastMsg) {
        lastAuthor = lastMsg.author.bot ? `  ← BOT: ${lastMsg.author.username}` : `  ← user: ${lastMsg.author.username}`;
      }
    } catch { /* ignore */ }

    console.log(`  [${status}] ${thread.name}  (in #${parentName}, ${age}${lastAuthor})`);
  }

  // --- Summary ---
  const allThreads = [...activeThreads.threads.values()];
  const archivedCount = allThreads.filter(t => t.archived).length;
  const activeCount = allThreads.length - archivedCount;
  console.log(`\n=== Summary ===`);
  console.log(`  Total from fetchActiveThreads: ${allThreads.length}`);
  console.log(`  Actually active (archived=false): ${activeCount}`);
  console.log(`  Leaked archived (archived=true): ${archivedCount}`);
  if (archivedCount > 0) {
    console.log(`  ⚠ Discord fetchActive is returning ${archivedCount} archived thread(s)!`);
  } else {
    console.log(`  ✓ No archived threads leaked through fetchActive.`);
  }

  await client.destroy();
}

function snowflakeToDate(snowflake: string): Date {
  const DISCORD_EPOCH = 1420070400000n;
  return new Date(Number((BigInt(snowflake) >> 22n) + DISCORD_EPOCH));
}

function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
