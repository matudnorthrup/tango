import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMissingReceiptCandidates,
  buildReimbursementGapCandidates,
  collectLinkedReceiptTransactionIds,
  formatReceiptCatalogCandidateDetails,
  formatReimbursementGapCandidateDetails,
} from "../src/receipt-catalog-precheck.js";

const cleanupDirs: string[] = [];
const originalTangoHome = process.env.TANGO_HOME;
const originalTangoProfile = process.env.TANGO_PROFILE;

afterEach(() => {
  if (originalTangoHome == null) {
    delete process.env.TANGO_HOME;
  } else {
    process.env.TANGO_HOME = originalTangoHome;
  }

  if (originalTangoProfile == null) {
    delete process.env.TANGO_PROFILE;
  } else {
    process.env.TANGO_PROFILE = originalTangoProfile;
  }

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
          id: 6001,
          date: "2026-04-03",
          payee: "Maid in Newport",
          original_name: "MAID IN NEWPORT",
          amount: "350.0000",
          status: "cleared",
        },
        {
          id: 6002,
          date: "2026-04-04",
          payee: "Factor",
          original_name: "FACTOR_",
          amount: "89.9900",
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
      {
        id: "6001",
        date: "2026-04-03",
        payee: "Maid in Newport",
        originalName: "MAID IN NEWPORT",
        amount: "350.00",
        status: "cleared",
      },
      {
        id: "6002",
        date: "2026-04-04",
        payee: "Factor",
        originalName: "FACTOR_",
        amount: "89.99",
        status: "uncleared",
      },
    ]);
    expect(formatReceiptCatalogCandidateDetails(candidates)).toContain("TXN 2375784675");
    expect(formatReceiptCatalogCandidateDetails(candidates)).toContain("$292.23");
    expect(formatReceiptCatalogCandidateDetails(candidates)).toContain("Maid in Newport");
    expect(formatReceiptCatalogCandidateDetails(candidates)).toContain("Factor");
  });

  it("builds reimbursement gap candidates for configured vendors and recurring receipts", () => {
    const tangoHome = fs.mkdtempSync(path.join(os.tmpdir(), "tango-profile-home-"));
    cleanupDirs.push(tangoHome);
    process.env.TANGO_HOME = tangoHome;
    process.env.TANGO_PROFILE = "receipt-precheck";

    const receiptsRoot = path.join(
      tangoHome,
      "profiles",
      "receipt-precheck",
      "data",
      "receipts",
    );
    fs.mkdirSync(path.join(receiptsRoot, "Venmo"), { recursive: true });
    fs.mkdirSync(path.join(receiptsRoot, "Factor"), { recursive: true });

    fs.writeFileSync(
      path.join(receiptsRoot, "Venmo", "2026-04-04 Payment 123.md"),
      [
        "# Venmo Payment to Kip Everitt",
        "",
        "- **Date:** 2026-04-04",
        "- **Total:** $600.00",
        "- **Recipient:** Kip Everitt",
      ].join("\n"),
    );

    fs.writeFileSync(
      path.join(receiptsRoot, "Factor", "2026-04-08 Invoice 456.md"),
      [
        "# Factor Invoice 456",
        "",
        "- **Date:** 2026-04-08",
        "- **Total:** $89.99",
        "- **Merchant:** Factor",
        "",
        "## Reimbursement Tracking",
        "",
        "- Status: submitted",
        "- System: Ramp",
        "- Amount: $89.99",
      ].join("\n"),
    );

    const candidates = buildReimbursementGapCandidates({
      receiptsRoot,
      since: "2026-04-01",
      until: "2026-04-30",
    });

    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "missing_tracking_section",
        vendorKey: "venmo_services",
        noteName: "Venmo/2026-04-04 Payment 123.md",
      }),
      expect.objectContaining({
        type: "stale_tracking",
        vendorKey: "factor",
        noteName: "Factor/2026-04-08 Invoice 456.md",
      }),
      expect.objectContaining({
        type: "missing_recurring_receipt",
        vendorKey: "maid_in_newport",
        month: "2026-04",
      }),
    ]));
    expect(formatReimbursementGapCandidateDetails(candidates)).toContain("missing_tracking_section");
    expect(formatReimbursementGapCandidateDetails(candidates)).toContain("stale_tracking");
    expect(formatReimbursementGapCandidateDetails(candidates)).toContain("missing_recurring_receipt");
  });
});
