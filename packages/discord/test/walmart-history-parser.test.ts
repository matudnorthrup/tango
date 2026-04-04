import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeHistory,
  findLikelyHistoryMatches,
  parseReceipts,
} from "../src/walmart-history-parser.js";

const RECEIPTS_ENV = "TANGO_WALMART_RECEIPTS_DIR";

describe("walmart-history-parser", () => {
  const originalReceiptsDir = process.env[RECEIPTS_ENV];

  afterEach(() => {
    if (originalReceiptsDir === undefined) {
      delete process.env[RECEIPTS_ENV];
    } else {
      process.env[RECEIPTS_ENV] = originalReceiptsDir;
    }
  });

  it("parses grocery summary lines and ignores metadata bullets", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-walmart-history-"));
    process.env[RECEIPTS_ENV] = tempDir;
    const filePath = path.join(tempDir, "2026-03-08 Order 2000145-26621876.md");

    fs.writeFileSync(
      filePath,
      [
        "---",
        "created: 2026-03-08",
        "---",
        "# Walmart Order 2000145-26621876",
        "",
        "- **Date:** 2026-03-08",
        "- **Total:** $213.66",
        "",
        "## Grocery Items (Summary)",
        "",
        "~$191.75 subtotal in groceries including: GV vanilla greek yogurt 32 oz (×6), La Abuela flour tortillas (×2), limes (×6), chicken thighs (4 family packs, ~$49.50 total).",
      ].join("\n"),
      "utf8",
    );

    try {
      const records = parseReceipts();
      expect(records.map((record) => record.itemName)).toEqual([
        "GV vanilla greek yogurt 32 oz",
        "La Abuela flour tortillas",
        "limes",
        "chicken thighs",
      ]);
      expect(records.map((record) => record.quantity)).toEqual([6, 2, 6, 4]);
      expect(records.find((record) => record.itemName === "chicken thighs")?.price).toBe(49.5);
      expect(records.some((record) => record.itemName.includes("**Total:**"))).toBe(false);

      const stats = analyzeHistory(records);
      const yogurtMatch = findLikelyHistoryMatches(stats, "light greek vanilla yogurt")[0];
      expect(yogurtMatch?.displayName).toBe("GV vanilla greek yogurt 32 oz");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
