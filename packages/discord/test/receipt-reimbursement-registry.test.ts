import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeFileSha256 } from "../src/reimbursement-evidence.js";
import {
  backfillWalmartReceiptNote,
  parseWalmartReceiptMarkdown,
  upsertWalmartReimbursementTracking,
} from "../src/receipt-reimbursement-registry.js";

describe("receipt reimbursement registry", () => {
  const originalReceiptDir = process.env.TANGO_WALMART_RECEIPTS_DIR;

  afterEach(() => {
    if (originalReceiptDir === undefined) {
      delete process.env.TANGO_WALMART_RECEIPTS_DIR;
    } else {
      process.env.TANGO_WALMART_RECEIPTS_DIR = originalReceiptDir;
    }
  });

  it("parses driver tip and reimbursement state from a Walmart receipt note", () => {
    const filePath = "/tmp/2026-04-01 Order 2000146-86460984.md";
    const markdown = [
      "# Walmart Order 2000146-86460984",
      "",
      "- **Date:** 2026-04-01",
      "- **Total:** $313.86",
      "- **Card Charge:** $317.88",
      "",
      "## Notes",
      "",
      "- Delivery from store, delivered Apr 01",
      "- Driver tip: $41.03 (charged separately)",
      "",
      "## Reimbursement Tracking",
      "",
      "- Status: submitted",
      "- System: Ramp",
      "- Amount: $41.03",
      "- Submitted: 2026-04-02",
      "- Note: executive buy back time",
    ].join("\n");

    const record = parseWalmartReceiptMarkdown(filePath, markdown);
    expect(record.orderId).toBe("2000146-86460984");
    expect(record.driverTip).toBe(41.03);
    expect(record.isDelivery).toBe(true);
    expect(record.reimbursement.status).toBe("submitted");
    expect(record.reimbursement.system).toBe("Ramp");
  });

  it("upserts a reimbursement tracking section into a receipt note", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-ramp-reimburse-"));
    const filePath = path.join(tempDir, "2026-04-01 Order 2000146-86460984.md");
    fs.writeFileSync(
      filePath,
      [
        "# Walmart Order 2000146-86460984",
        "",
        "- **Date:** 2026-04-01",
        "- **Total:** $313.86",
        "",
        "## Notes",
        "",
        "- Delivery from store, delivered Apr 01",
        "- Driver tip: $41.03 (charged separately)",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = upsertWalmartReimbursementTracking({
      notePath: filePath,
      status: "submitted",
      system: "Ramp",
      submitted: "2026-04-02",
      note: "executive buy back time",
      evidencePath: "/tmp/tango-screenshot.png",
    });

    expect(result.reimbursement.status).toBe("submitted");
    const updated = fs.readFileSync(filePath, "utf8");
    expect(updated).toContain("## Reimbursement Tracking");
    expect(updated).toContain("- Status: submitted");
    expect(updated).toContain("- System: Ramp");
    expect(updated).toContain("- Amount: $41.03");
    expect(updated).toContain("- Note: executive buy back time");
    expect(updated).toContain("- Evidence: /tmp/tango-screenshot.png");
  });

  it("hydrates evidence provenance fields from the archived evidence sidecar", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-ramp-evidence-"));
    const filePath = path.join(tempDir, "2026-03-20 Order 2000142-13122385.md");
    fs.writeFileSync(
      filePath,
      [
        "# Walmart Order 2000142-13122385",
        "",
        "- **Date:** 2026-03-20",
        "- **Total:** $232.35",
        "",
        "## Notes",
        "",
        "Delivery from store. Delivered on Mar 20. Driver tip: $35.23 (charged separately).",
        "",
      ].join("\n"),
      "utf8",
    );

    const sourceImagePath = path.join(tempDir, "walmart-evidence.png");
    fs.writeFileSync(
      sourceImagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yF9kAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const evidencePath = path.join(tempDir, "archived-walmart-evidence.png");
    fs.copyFileSync(sourceImagePath, evidencePath);
    fs.writeFileSync(
      `${evidencePath}.json`,
      `${JSON.stringify({
        version: 1,
        kind: "walmart_tip_evidence",
        orderId: "2000142-13122385",
        sourcePath: sourceImagePath,
        archivedPath: evidencePath,
        sha256: computeFileSha256(evidencePath),
        fileSize: fs.statSync(evidencePath).size,
        imageWidth: 1,
        imageHeight: 1,
        captureMode: "viewport-with-date-context",
        dateVisible: true,
        visibleDateText: ["Mar 20"],
        rampReportId: "report-123",
        rampConfirmationPath: "/tmp/ramp-confirmation.png",
      }, null, 2)}\n`,
      "utf8",
    );

    upsertWalmartReimbursementTracking({
      notePath: filePath,
      status: "submitted",
      submitted: "2026-04-02",
      evidencePath,
    });

    const updated = fs.readFileSync(filePath, "utf8");
    expect(updated).toContain(`- Evidence: ${evidencePath}`);
    expect(updated).toContain(`- Evidence Source: ${sourceImagePath}`);
    expect(updated).toContain(`- Evidence SHA256: ${computeFileSha256(evidencePath)}`);
    expect(updated).toContain("- Evidence Dimensions: 1x1");
    expect(updated).toContain("- Evidence Capture Mode: viewport-with-date-context");
    expect(updated).toContain("- Evidence Date Visible: yes");
    expect(updated).toContain("- Evidence Date Text: Mar 20");
    expect(updated).toContain("- Ramp Report ID: report-123");
    expect(updated).toContain("- Ramp Confirmation: /tmp/ramp-confirmation.png");
  });

  it("parses older Walmart delivery receipts that mention driver tips in prose or tables", () => {
    const proseRecord = parseWalmartReceiptMarkdown(
      "/tmp/2026-03-03 Order 2000142-28686389.md",
      [
        "# Walmart Order 2000142-28686389",
        "",
        "- **Date:** 2026-03-03",
        "",
        "## Linked Transactions",
        "",
        "- Lunch Money TXN 2364589925: $17.48 (driver tip — uncategorized)",
        "- Lunch Money TXN 2364589926: $273.42 (final order charge $254.66 + driver tip $18.76 — uncategorized)",
        "",
        "## Notes",
        "",
        "Order total $290.90 = items after savings $254.16 + bag fee $0.50 + driver tips $36.24. Delivered to 100 Example Road, Exampletown OR.",
      ].join("\n"),
    );
    expect(proseRecord.driverTip).toBe(36.24);
    expect(proseRecord.isDelivery).toBe(true);

    const tableRecord = parseWalmartReceiptMarkdown(
      "/tmp/2026-03-08 Order 2000145-26621876.md",
      [
        "# Walmart Order 2000145-26621876",
        "",
        "- **Date:** 2026-03-08",
        "- **Delivered:** 2026-03-09",
        "",
        "## Order Totals",
        "",
        "| Line | Amount |",
        "|------|--------|",
        "| Driver tip | $27.38 |",
      ].join("\n"),
    );
    expect(tableRecord.driverTip).toBe(27.38);
    expect(tableRecord.isDelivery).toBe(true);
  });

  it("parses inline note prose that uses 'Driver tip:' with a colon", () => {
    const record = parseWalmartReceiptMarkdown(
      "/tmp/2026-03-20 Order 2000142-13122385.md",
      [
        "# Walmart Order 2000142-13122385",
        "",
        "- **Date:** 2026-03-20",
        "- **Total:** $232.35",
        "",
        "## Notes",
        "",
        "Delivery from store. Delivered on Mar 20. Driver tip: $35.23 (charged separately). Bag fee: $0.50.",
      ].join("\n"),
    );

    expect(record.driverTip).toBe(35.23);
    expect(record.isDelivery).toBe(true);
  });

  it("creates a missing Walmart receipt note from backfill data", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-ramp-backfill-"));
    process.env.TANGO_WALMART_RECEIPTS_DIR = tempDir;

    const record = backfillWalmartReceiptNote({
      orderId: "2000139-64770733",
      date: "2025-10-16",
      total: 205.26,
      cardCharge: "$205.26 (temporary hold $211.03 shown)",
      itemsLine: "51 received",
      notes: "Delivery from store. Delivered on Oct 16, 2025. Driver tip $26.67 charged separately after delivery.",
      driverTip: 26.67,
    });

    const filePath = path.join(tempDir, "2025-10-16 Order 2000139-64770733.md");
    expect(record.filePath).toBe(filePath);
    expect(fs.existsSync(filePath)).toBe(true);
    const markdown = fs.readFileSync(filePath, "utf8");
    expect(markdown).toContain("# Walmart Order 2000139-64770733");
    expect(markdown).toContain("- **Date:** 2025-10-16");
    expect(markdown).toContain("- Status: not_submitted");
    expect(markdown).toContain("- Amount: $26.67");
    expect(markdown).toContain("Delivery from store. Delivered on Oct 16, 2025.");
  });
});
