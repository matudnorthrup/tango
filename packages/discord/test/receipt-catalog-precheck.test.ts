import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMissingReceiptCandidates,
  collectLinkedReceiptTransactionIds,
  formatReceiptCatalogCandidateDetails,
} from "../src/receipt-catalog-precheck.js";

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("receipt catalog precheck", () => {
  it("extracts linked transaction ids from receipt markdown", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-receipt-precheck-"));
    cleanupDirs.push(dir);
    const amazonDir = path.join(dir, "Amazon");
    fs.mkdirSync(amazonDir, { recursive: true });
    fs.writeFileSync(
      path.join(amazonDir, "2026-04-01 Order 123.md"),
      [
        "# Amazon Order 123",
        "",
        "## Linked Transactions",
        "- Lunch Money TXN 2376200290: $109.78",
        "  - TXN 2376496784: $244.64",
      ].join("\n"),
    );

    const ids = collectLinkedReceiptTransactionIds(dir);
    expect(ids).toEqual(new Set(["2376200290", "2376496784"]));
  });

  it("returns retailer transactions that are still missing linked receipt notes", () => {
    const candidates = buildMissingReceiptCandidates(
      [
        {
          id: 2376200290,
          date: "2026-04-01",
          payee: "Amazon",
          original_name: "AMAZON MKTPL*BC5RG8Y02",
          amount: "109.7800",
          status: "uncleared",
        },
        {
          id: 2375784675,
          date: "2026-04-02",
          payee: "Amazon",
          original_name: "AMAZON MKTPLACE PMTS",
          amount: "292.2300",
          status: "pending",
        },
        {
          id: 2376496784,
          date: "2026-04-02",
          payee: "Walmart",
          original_name: null,
          amount: "244.6400",
          status: "uncleared",
        },
        {
          id: 999,
          date: "2026-04-03",
          payee: "Ace Hardware",
          original_name: "Ace Hardware",
          amount: "9.59",
          status: "uncleared",
        },
      ],
      new Set(["2376200290", "2376496784"]),
    );

    expect(candidates).toEqual([
      {
        id: "2375784675",
        date: "2026-04-02",
        payee: "Amazon",
        originalName: "AMAZON MKTPLACE PMTS",
        amount: "292.23",
        status: "pending",
      },
    ]);
    expect(formatReceiptCatalogCandidateDetails(candidates)).toContain("TXN 2375784675");
    expect(formatReceiptCatalogCandidateDetails(candidates)).toContain("$292.23");
  });
});
