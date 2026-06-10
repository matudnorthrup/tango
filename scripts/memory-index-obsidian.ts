/**
 * Run the Obsidian memory index on demand (same pipeline as the daily
 * memory-index-obsidian schedule): chunk changed vault files into the core
 * store with embeddings, mirror them into Atlas (TGO-691), and backfill
 * embeddings for rows that are missing one (TGO-692).
 *
 * Usage:
 *   node --import tsx scripts/memory-index-obsidian.ts [--dry-run] [--full-resync]
 *
 * --full-resync clears the obsidian_index hash entries first so every vault
 * file re-chunks, re-embeds, and re-syncs to Atlas. Use once after deploying
 * the Atlas sync to bring both stores current.
 *
 * Respects TANGO_PROFILE / TANGO_OBSIDIAN_VAULT / VOYAGE_API_KEY /
 * ATLAS_MEMORY_DB from the environment (.env is loaded).
 */
import dotenv from "dotenv";
import {
  backfillMissingMemoryEmbeddings,
  createVoyageEmbeddingProviderFromEnv,
  indexObsidianVault,
  resolveDatabasePath,
  TangoStorage,
} from "@tango/core";
import {
  addObsidianMemories,
  deleteObsidianMemoriesBySourceRefPrefix,
  openAtlasMemoryDatabase,
} from "@tango/atlas-memory";

dotenv.config();

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const fullResync = process.argv.includes("--full-resync");

  const storage = new TangoStorage(resolveDatabasePath());
  const { db: atlasDb } = openAtlasMemoryDatabase({});
  const embeddingProvider = createVoyageEmbeddingProviderFromEnv();
  if (!embeddingProvider) {
    console.warn("[memory-index-obsidian] no VOYAGE_API_KEY — indexing without embeddings");
  }

  try {
    if (fullResync && !dryRun) {
      const cleared = storage.clearObsidianIndexEntries();
      console.log(`[memory-index-obsidian] full resync: cleared ${cleared} index entries`);
    }

    const result = await indexObsidianVault({
      storage,
      embeddingProvider,
      dryRun,
      secondarySink: dryRun
        ? null
        : {
            prune: (sourceRefPrefix) =>
              deleteObsidianMemoriesBySourceRefPrefix(atlasDb, sourceRefPrefix),
            addChunks: (chunks) => addObsidianMemories(atlasDb, chunks),
          },
    });

    console.log(
      `[memory-index-obsidian] scanned=${result.scannedFileCount} indexed=${result.indexedFileCount} ` +
        `unchanged=${result.unchangedFileCount} removed=${result.removedFileCount} ` +
        `inserted=${result.insertedMemoryCount} embedded=${result.embeddedMemoryCount} ` +
        `embedFailed=${result.embedFailedCount} atlasSynced=${result.sinkSyncedCount} ` +
        `atlasErrors=${result.sinkErrorCount}` +
        (result.embedErrors.length > 0 ? ` embedErrors=${JSON.stringify(result.embedErrors)}` : "")
    );

    if (!dryRun) {
      const missing = await backfillMissingMemoryEmbeddings({
        storage,
        embeddingProvider,
        source: "obsidian",
      });
      console.log(
        `[memory-index-obsidian] missing-embedding backfill: scanned=${missing.scannedCount} ` +
          `embedded=${missing.embeddedCount} failed=${missing.failedCount}` +
          (missing.embedErrors.length > 0 ? ` errors=${JSON.stringify(missing.embedErrors)}` : "")
      );
    }
  } finally {
    atlasDb.close();
    storage.close();
  }
}

main().catch((error) => {
  console.error("[memory-index-obsidian] failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
