import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectReimbursementGaps,
  listReimbursementCandidates,
  lookupReceiptRecords,
  reconcileUniversalReimbursements,
  upsertReimbursementTracking,
} from "../src/receipt-universal-registry.js";

const cleanupDirs: string[] = [];
const originalTangoHome = process.env.TANGO_HOME;
const originalTangoProfile = process.env.TANGO_PROFILE;

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  if (originalTangoHome === undefined) {
    delete process.env.TANGO_HOME;
  } else {
    process.env.TANGO_HOME = originalTangoHome;
  }
  if (originalTangoProfile === undefined) {
    delete process.env.TANGO_PROFILE;
  } else {
    process.env.TANGO_PROFILE = originalTangoProfile;
  }
});

describe("receipt universal registry", () => {
  it("looks up itemized receipts by linked Lunch Money transaction id", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tango-receipt-lookup-home-"));
    cleanupDirs.push(tempHome);
    process.env.TANGO_HOME = tempHome;
    process.env.TANGO_PROFILE = "test";

    const receiptDir = path.join(tempHome, "profiles", "test", "data", "receipts", "Walmart");
    fs.mkdirSync(receiptDir, { recursive: true });
    fs.writeFileSync(
      path.join(receiptDir, "2026-05-21 Walmart Store Purchase TC6140-2026-0983-8550-124.md"),
      [
        "# Walmart Store Purchase - May 21, 2026",
        "",
        "- **Date:** 2026-05-21",
        "- **Store:** Lindon Supercenter - 585 N State St, Lindon, UT 84042",
        "- **TC#:** 6140-2026-0983-8550-124",
        "- **Subtotal:** $50.19",
        "- **Tax:** $3.51",
        "- **Total:** $53.70",
        "",
        "## Items",
        "",
        "| Item | Qty | Price |",
        "|------|-----|-------|",
        "| George Men's Solid Black Slim Necktie | 1 | $10.00 |",
        "| Mens Primry Color Synthetic Player Jersey | 1 | $33.00 |",
        "| Great Value Whole Strawberries 16 oz (Frozen) | 1 | $2.86 |",
        "",
        "## Category Notes",
        "",
        "- Necktie, Jersey -> Clothing & Accessories",
        "- Frozen strawberries -> Groceries",
        "",
        "## Linked Transactions",
        "",
        "- Lunch Money TXN 2403517923: $53.70 (Walmart, Chase Sapphire - uncleared)",
      ].join("\n"),
      "utf8",
    );

    const matches = lookupReceiptRecords({
      transactionId: "2403517923",
      rootDir: path.join(tempHome, "profiles", "test", "data", "receipts"),
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.reasons).toContain("linked_transaction_id");
    expect(matches[0]?.record.fields.Store).toContain("Lindon Supercenter");
    expect(matches[0]?.record.linkedTransactions).toEqual([
      expect.objectContaining({
        id: "2403517923",
        amount: 53.7,
      }),
    ]);
    expect(matches[0]?.record.lineItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        item: "George Men's Solid Black Slim Necktie",
        price: 10,
      }),
      expect.objectContaining({
        item: "Mens Primry Color Synthetic Player Jersey",
        price: 33,
      }),
    ]));
    expect(matches[0]?.record.categoryNotes).toContain("Frozen strawberries -> Groceries");
    expect(matches[0]?.lunchMoneyNote).toContain("Items:\n- George Men's Solid Black Slim Necktie - $10.00");
    expect(matches[0]?.lunchMoneyNote).toContain("- Great Value Whole Strawberries 16 oz (Frozen) - $2.86");
    expect(matches[0]?.lunchMoneyNote).toContain("Total: $53.70");
    expect(matches[0]?.lunchMoneyNote).toContain(
      "Categories: Necktie, Jersey -> Clothing & Accessories; Frozen strawberries -> Groceries",
    );
    expect(matches[0]?.lunchMoneyNote.trim().split("\n").at(-1)).toBe(
      "Receipt: obsidian://open?vault=main&file=Records%2FFinance%2FReceipts%2FWalmart%2F2026-05-21%20Walmart%20Store%20Purchase%20TC6140-2026-0983-8550-124.md",
    );
  });

  it("builds receipt-backed Lunch Money notes even when item rows are missing", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tango-receipt-summary-note-home-"));
    cleanupDirs.push(tempHome);
    process.env.TANGO_HOME = tempHome;
    process.env.TANGO_PROFILE = "test";

    const receiptDir = path.join(tempHome, "profiles", "test", "data", "receipts", "Amazon");
    fs.mkdirSync(receiptDir, { recursive: true });
    fs.writeFileSync(
      path.join(receiptDir, "2026-05-22 Amazon Order 123.md"),
      [
        "# Amazon Order 123",
        "",
        "- **Date:** 2026-05-22",
        "- **Merchant:** Amazon",
        "- **Total:** $42.19",
        "",
        "## Linked Transactions",
        "",
        "- Lunch Money TXN 2403518000: $42.19 (Amazon, Chase Sapphire - uncleared)",
      ].join("\n"),
      "utf8",
    );

    const matches = lookupReceiptRecords({
      transactionId: "2403518000",
      rootDir: path.join(tempHome, "profiles", "test", "data", "receipts"),
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.lunchMoneyNote).toContain("Summary: Amazon Order 123; merchant Amazon");
    expect(matches[0]?.lunchMoneyNote).toContain("Total: $42.19");
    expect(matches[0]?.lunchMoneyNote.trim().split("\n").at(-1)).toBe(
      "Receipt: obsidian://open?vault=main&file=Records%2FFinance%2FReceipts%2FAmazon%2F2026-05-22%20Amazon%20Order%20123.md",
    );
  });

  it("repairs reimbursement frontmatter when upserting tracking state", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-universal-receipts-"));
    cleanupDirs.push(tempDir);
    const filePath = path.join(tempDir, "2026-04-07 Maid in Newport Invoice 1707.md");

    fs.writeFileSync(
      filePath,
      [
        "---",
        "date: 2026-04-07",
        "areas:",
        "  - \"[[Finance]]\"",
        "---",
        "# Maid in Newport Invoice 1707",
        "",
        "- **Date:** 2026-04-07",
        "- **Total:** $350.00",
        "- **Merchant:** Maid in Newport",
        "",
        "## Notes",
        "",
        "House cleaning invoice.",
      ].join("\n"),
      "utf8",
    );

    const result = upsertReimbursementTracking({
      notePath: filePath,
      vendor: "maid_in_newport",
      status: "not_submitted",
      system: "Ramp",
      amount: 350,
      note: "Exec Buy Back Time",
    });

    expect(result.reimbursement.status).toBe("not_submitted");

    const updated = fs.readFileSync(filePath, "utf8");
    expect(updated).toContain("reimbursable: true");
    expect(updated).toContain("ramp_submitted: null");
    expect(updated).toContain("ramp_report_id: null");
    expect(updated).toContain("merchant: Maid in Newport");
    expect(updated).toContain("amount: 350.00");
    expect(updated).toContain("## Reimbursement Tracking");
    expect(updated).toContain("- Status: not_submitted");
  });

  it("reads frontmatter dates and table reimbursement fields for Walmart candidates", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tango-universal-walmart-home-"));
    cleanupDirs.push(tempHome);
    process.env.TANGO_HOME = tempHome;
    process.env.TANGO_PROFILE = "test";

    const receiptDir = path.join(tempHome, "profiles", "test", "data", "receipts", "Walmart");
    fs.mkdirSync(receiptDir, { recursive: true });
    fs.writeFileSync(
      path.join(receiptDir, "2026-05-27 Order 2000149-10045684.md"),
      [
        "---",
        "date: 2026-05-27",
        "types:",
        "  - \"[[Receipt]]\"",
        "areas:",
        "  - \"[[Finance]]\"",
        "merchant: \"Walmart (Delivery from Store)\"",
        "order_number: \"2000149-10045684\"",
        "total: 266.59",
        "reimbursable: true",
        "amount: 24.94",
        "source_kind: record",
        "---",
        "# Walmart Order 2000149-10045684",
        "",
        "| Field | Value |",
        "|-------|-------|",
        "| Date | 2026-05-27 |",
        "| Driver tip | $24.94 |",
        "| Total | $266.59 |",
        "",
        "## Reimbursement Tracking",
        "",
        "| Field | Value |",
        "|-------|-------|",
        "| Status | not_submitted |",
        "| System | Ramp |",
        "| Reimbursable Item | Driver tip |",
        "| Amount | $24.94 |",
        "| Note | Exec Buy Back Time |",
      ].join("\n"),
      "utf8",
    );

    const candidates = listReimbursementCandidates({
      since: "2026-05-27",
      until: "2026-05-27",
      vendor: "walmart_tip",
      includeSubmitted: true,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.date).toBe("2026-05-27");
    expect(candidates[0]?.reimbursableAmount).toBe(24.94);
    expect(candidates[0]?.reimbursement.status).toBe("not_submitted");
    expect(candidates[0]?.reimbursement.system).toBe("Ramp");
    expect(candidates[0]?.reimbursement.note).toBe("Exec Buy Back Time");

    const gaps = detectReimbursementGaps({
      since: "2026-05-27",
      until: "2026-05-27",
      vendor: "walmart_tip",
    });
    expect(gaps.gaps.some((gap) => gap.type === "missing_date")).toBe(false);
  });

  it("treats draft notes with no live Ramp match as pending", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tango-universal-stale-draft-home-"));
    cleanupDirs.push(tempHome);
    process.env.TANGO_HOME = tempHome;
    process.env.TANGO_PROFILE = "test";

    const receiptDir = path.join(tempHome, "profiles", "test", "data", "receipts", "Maid in Newport");
    fs.mkdirSync(receiptDir, { recursive: true });
    const filePath = path.join(receiptDir, "2026-04-07 Maid in Newport Invoice 1707.md");
    fs.writeFileSync(
      filePath,
      [
        "---",
        "date: 2026-04-07",
        "areas:",
        "  - \"[[Finance]]\"",
        "---",
        "# Maid in Newport Invoice 1707",
        "",
        "- **Date:** 2026-04-07",
        "- **Total:** $350.00",
        "- **Merchant:** Maid in Newport",
        "",
        "## Reimbursement Tracking",
        "",
        "- Status: draft",
        "- System: Ramp",
        "- Reimbursable Item: House cleaning",
        "- Amount: $350.00",
        "- Note: Exec Buy Back Time",
        "- Ramp Report ID: stale-draft-id",
      ].join("\n"),
      "utf8",
    );

    const reconciled = reconcileUniversalReimbursements({
      history: [],
      since: "2026-04-01",
      vendor: "maid_in_newport",
      updateNotes: true,
    });

    expect(reconciled.pending).toHaveLength(1);
    expect(reconciled.pending[0]?.reimbursement.status).toBe("not_submitted");
    expect(reconciled.pending[0]?.reimbursement.rampReportId).toBeUndefined();
    expect(reconciled.updated).toHaveLength(1);

    const updated = fs.readFileSync(filePath, "utf8");
    expect(updated).toContain("- Status: not_submitted");
    expect(updated).not.toContain("stale-draft-id");
    expect(updated).not.toContain("- Ramp Report ID:");
  });
});
