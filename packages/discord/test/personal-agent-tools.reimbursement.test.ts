import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { manager, registry, evidence } = vi.hoisted(() => ({
  manager: {
    launch: vi.fn(),
    captureWalmartTipEvidence: vi.fn(),
    captureEmailReimbursementEvidence: vi.fn(),
    listRampReimbursementHistory: vi.fn(),
    submitRampReimbursement: vi.fn(),
    replaceRampReimbursementReceipt: vi.fn(),
  },
  registry: {
    backfillWalmartReceiptNote: vi.fn(),
    findWalmartReceiptRecord: vi.fn(),
    listWalmartDeliveryCandidates: vi.fn(),
    reconcileWalmartReimbursementsAgainstRamp: vi.fn(),
    upsertWalmartReimbursementTracking: vi.fn(),
  },
  evidence: {
    loadReimbursementEvidenceRecord: vi.fn(),
  },
}));

vi.mock("../src/browser-manager.js", () => ({
  getBrowserManager: () => manager,
}));

vi.mock("../src/receipt-reimbursement-registry.js", () => registry);

vi.mock("../src/reimbursement-evidence.js", () => evidence);

import { createReimbursementAutomationTools } from "../src/personal-agent-tools.js";

const cleanupDirs: string[] = [];
const originalTangoHome = process.env.TANGO_HOME;
const originalTangoProfile = process.env.TANGO_PROFILE;

describe("personal-agent-tools reimbursement automation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const tangoHome = fs.mkdtempSync(path.join(os.tmpdir(), "tango-reimbursement-tool-"));
    cleanupDirs.push(tangoHome);
    process.env.TANGO_HOME = tangoHome;
    process.env.TANGO_PROFILE = "tool-test";
    fs.mkdirSync(path.join(tangoHome, "profiles", "tool-test", "data", "receipts"), {
      recursive: true,
    });
    manager.launch.mockResolvedValue("Connected");
    manager.listRampReimbursementHistory.mockResolvedValue([]);
    registry.findWalmartReceiptRecord.mockReturnValue(null);
    evidence.loadReimbursementEvidenceRecord.mockReturnValue(null);
  });

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

  it("captures Walmart tip evidence through BrowserManager", async () => {
    manager.captureWalmartTipEvidence.mockResolvedValue({
      orderUrl: "https://www.walmart.com/orders/abc",
      screenshotPath: "/tmp/walmart.png",
      tipText: "Driver tip $27.38",
      selectorUsed: "div.bill-order-payment-spacing",
    });

    const tool = createReimbursementAutomationTools()[0];
    if (!tool) throw new Error("Missing tool");

    const result = await tool.handler({
      action: "capture_walmart_tip_evidence",
      order_url: "https://www.walmart.com/orders/abc",
      output_path: "/tmp/walmart.png",
    });

    expect(manager.launch).toHaveBeenCalledWith(9223);
    expect(manager.captureWalmartTipEvidence).toHaveBeenCalledWith({
      orderUrl: "https://www.walmart.com/orders/abc",
      outputPath: "/tmp/walmart.png",
    });
    expect(result).toEqual({
      result: {
        orderUrl: "https://www.walmart.com/orders/abc",
        screenshotPath: "/tmp/walmart.png",
        tipText: "Driver tip $27.38",
        selectorUsed: "div.bill-order-payment-spacing",
      },
    });
  });

  it("submits a Ramp reimbursement through BrowserManager", async () => {
    manager.submitRampReimbursement.mockResolvedValue({
      reviewUrl: "https://app.ramp.com/details/reimbursements/abc/review",
      rampReportId: "abc",
      amount: 27.38,
      transactionDate: "03/08/2026",
      memo: "executive buy back time",
    });

    const tool = createReimbursementAutomationTools()[0];
    if (!tool) throw new Error("Missing tool");

    const result = await tool.handler({
      action: "submit_ramp_reimbursement",
      amount: 27.38,
      transaction_date: "2026-03-08",
      memo: "executive buy back time",
      evidence_path: "/tmp/walmart.png",
      merchant: "Walmart",
    });

    expect(manager.submitRampReimbursement).toHaveBeenCalledWith({
      amount: 27.38,
      transactionDate: "2026-03-08",
      memo: "executive buy back time",
      evidencePath: "/tmp/walmart.png",
      merchant: "Walmart",
    });
    expect(manager.listRampReimbursementHistory).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      result: {
        reviewUrl: "https://app.ramp.com/details/reimbursements/abc/review",
        rampReportId: "abc",
        amount: 27.38,
        transactionDate: "03/08/2026",
        memo: "executive buy back time",
      },
      draftUrl: "https://app.ramp.com/details/reimbursements/abc/review",
      message: "Ramp reimbursement draft created - ready for manual review at https://app.ramp.com/details/reimbursements/abc/review",
    });
  });

  it("blocks duplicate Ramp reimbursements unless skip_dedup_check is true", async () => {
    manager.listRampReimbursementHistory.mockResolvedValue([
      {
        merchant: "Factor",
        amount: 89.99,
        transactionDate: "2026-04-08",
        submittedDate: "2026-04-09",
        memo: "executive buy back time",
        reviewUrl: "https://app.ramp.com/details/reimbursements/existing/review",
        rampReportId: "existing",
      },
    ]);

    const tool = createReimbursementAutomationTools()[0];
    if (!tool) throw new Error("Missing tool");

    const blocked = await tool.handler({
      action: "submit_ramp_reimbursement",
      amount: 89.99,
      transaction_date: "2026-04-08",
      evidence_path: "/tmp/factor.pdf",
      vendor: "factor",
    });

    expect(manager.submitRampReimbursement).not.toHaveBeenCalled();
    expect(blocked).toEqual(expect.objectContaining({
      error: expect.stringContaining("submit_ramp_reimbursement blocked by dedup gate"),
      dedup: expect.objectContaining({
        duplicate: true,
        reasons: expect.arrayContaining(["matching_ramp_history"]),
      }),
    }));

    manager.submitRampReimbursement.mockResolvedValue({
      reviewUrl: "https://app.ramp.com/details/reimbursements/new/review",
      rampReportId: "new",
      amount: 89.99,
      transactionDate: "04/08/2026",
      memo: "executive buy back time",
    });

    const forced = await tool.handler({
      action: "submit_ramp_reimbursement",
      amount: 89.99,
      transaction_date: "2026-04-08",
      evidence_path: "/tmp/factor.pdf",
      vendor: "factor",
      skip_dedup_check: true,
    });

    expect(manager.submitRampReimbursement).toHaveBeenCalledWith({
      amount: 89.99,
      transactionDate: "2026-04-08",
      memo: "executive buy back time",
      evidencePath: "/tmp/factor.pdf",
      merchant: "Factor",
    });
    expect(forced).toEqual({
      result: {
        reviewUrl: "https://app.ramp.com/details/reimbursements/new/review",
        rampReportId: "new",
        amount: 89.99,
        transactionDate: "04/08/2026",
        memo: "executive buy back time",
      },
      draftUrl: "https://app.ramp.com/details/reimbursements/new/review",
      message: "Ramp reimbursement draft created - ready for manual review at https://app.ramp.com/details/reimbursements/new/review",
    });
  });

  it("captures Gmail receipt evidence through BrowserManager", async () => {
    manager.captureEmailReimbursementEvidence.mockResolvedValue({
      screenshotPath: "/tmp/ramp-email.png",
      archivedPath: "/tmp/archive/ramp-email.png",
      sha256: "abc123",
      bodyFormat: "html",
      subject: "You paid Kip Everitt $600.00",
    });

    const tool = createReimbursementAutomationTools()[0];
    if (!tool) throw new Error("Missing tool");

    const result = await tool.handler({
      action: "capture_email_reimbursement_evidence",
      email_content: "subject\tYou paid Kip Everitt $600.00\n\n<html>Receipt</html>",
      output_path: "/tmp/ramp-email.png",
      label: "tree-service",
    });

    expect(manager.launch).toHaveBeenCalledWith(9223);
    expect(manager.captureEmailReimbursementEvidence).toHaveBeenCalledWith({
      emailContent: "subject\tYou paid Kip Everitt $600.00\n\n<html>Receipt</html>",
      outputPath: "/tmp/ramp-email.png",
      label: "tree-service",
    });
    expect(result).toEqual({
      result: {
        screenshotPath: "/tmp/ramp-email.png",
        archivedPath: "/tmp/archive/ramp-email.png",
        sha256: "abc123",
        bodyFormat: "html",
        subject: "You paid Kip Everitt $600.00",
      },
    });
  });

  it("syncs Walmart receipt tracking after a successful Ramp submission", async () => {
    manager.submitRampReimbursement.mockResolvedValue({
      reviewUrl: "https://app.ramp.com/details/reimbursements/abc/review",
      rampReportId: "abc",
      amount: 41.03,
      transactionDate: "04/01/2026",
      memo: "executive buy back time",
      evidencePath: "/tmp/archive/walmart-tip.png",
    });
    evidence.loadReimbursementEvidenceRecord.mockReturnValue({
      orderId: "2000146-86460984",
      archivedPath: "/tmp/archive/walmart-tip.png",
    });
    registry.findWalmartReceiptRecord.mockReturnValue({
      orderId: "2000146-86460984",
      reimbursement: {},
    });

    const tool = createReimbursementAutomationTools()[0];
    if (!tool) throw new Error("Missing tool");

    await tool.handler({
      action: "submit_ramp_reimbursement",
      amount: 41.03,
      transaction_date: "2026-04-01",
      memo: "executive buy back time",
      evidence_path: "/tmp/walmart-tip.png",
      merchant: "Walmart",
    });

    expect(registry.upsertWalmartReimbursementTracking).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "2000146-86460984",
        status: "draft",
        system: "Ramp",
        reimbursableItem: "Driver tip",
        amount: 41.03,
        note: "executive buy back time",
        evidencePath: "/tmp/archive/walmart-tip.png",
        rampReportId: "abc",
        submitted: expect.any(String),
      }),
    );
  });
});
