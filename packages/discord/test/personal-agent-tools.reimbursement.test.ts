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
    prepareRampReimbursementDraft: vi.fn(),
    submitRampReimbursement: vi.fn(),
    submitReviewedRampReimbursement: vi.fn(),
    repairRampReimbursementDraft: vi.fn(),
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
    registry.listWalmartDeliveryCandidates.mockReturnValue([]);
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

  it("prepares a Ramp reimbursement draft through BrowserManager", async () => {
    manager.prepareRampReimbursementDraft.mockResolvedValue({
      reviewUrl: "https://app.ramp.com/details/reimbursements/abc/review",
      rampReportId: "abc",
      amount: 27.38,
      transactionDate: "03/08/2026",
      memo: "Exec Buy Back Time",
    });

    const tool = createReimbursementAutomationTools()[0];
    if (!tool) throw new Error("Missing tool");

    const result = await tool.handler({
      action: "prepare_ramp_reimbursement_draft",
      amount: 27.38,
      transaction_date: "2026-03-08",
      memo: "Exec Buy Back Time",
      evidence_path: "/tmp/walmart.png",
      merchant: "Walmart",
    });

    expect(manager.prepareRampReimbursementDraft).toHaveBeenCalledWith({
      amount: 27.38,
      transactionDate: "2026-03-08",
      memo: "Exec Buy Back Time",
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
        memo: "Exec Buy Back Time",
      },
      draftUrl: "https://app.ramp.com/details/reimbursements/abc/review",
      message: "Ramp reimbursement draft prepared for manual review at https://app.ramp.com/details/reimbursements/abc/review. It has not been submitted.",
      deprecatedAlias: undefined,
    });
  });

  it("blocks duplicate Ramp reimbursements unless skip_dedup_check is true", async () => {
    manager.listRampReimbursementHistory.mockResolvedValue([
      {
        merchant: "Factor",
        amount: 89.99,
        transactionDate: "2026-04-08",
        submittedDate: "2026-04-09",
        memo: "Exec Buy Back Time",
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

    expect(manager.prepareRampReimbursementDraft).not.toHaveBeenCalled();
    expect(blocked).toEqual(expect.objectContaining({
      error: expect.stringContaining("submit_ramp_reimbursement blocked by dedup gate"),
      dedup: expect.objectContaining({
        duplicate: true,
        reasons: expect.arrayContaining(["matching_ramp_history"]),
      }),
    }));

    manager.prepareRampReimbursementDraft.mockResolvedValue({
      reviewUrl: "https://app.ramp.com/details/reimbursements/new/review",
      rampReportId: "new",
      amount: 89.99,
      transactionDate: "04/08/2026",
      memo: "Exec Buy Back Time",
    });

    const forced = await tool.handler({
      action: "submit_ramp_reimbursement",
      amount: 89.99,
      transaction_date: "2026-04-08",
      evidence_path: "/tmp/factor.pdf",
      vendor: "factor",
      skip_dedup_check: true,
    });

    expect(manager.prepareRampReimbursementDraft).toHaveBeenCalledWith({
      amount: 89.99,
      transactionDate: "2026-04-08",
      memo: "Exec Buy Back Time",
      evidencePath: "/tmp/factor.pdf",
      merchant: "Factor",
    });
    expect(forced).toEqual({
      result: {
        reviewUrl: "https://app.ramp.com/details/reimbursements/new/review",
        rampReportId: "new",
        amount: 89.99,
        transactionDate: "04/08/2026",
        memo: "Exec Buy Back Time",
      },
      draftUrl: "https://app.ramp.com/details/reimbursements/new/review",
      message: "Ramp reimbursement draft prepared for manual review at https://app.ramp.com/details/reimbursements/new/review. It has not been submitted.",
      deprecatedAlias: "submit_ramp_reimbursement now prepares a draft only; prefer prepare_ramp_reimbursement_draft.",
    });
  });

  it("blocks a duplicate Ramp draft before preparing another draft", async () => {
    manager.listRampReimbursementHistory.mockResolvedValue([
      {
        merchant: "Walmart",
        amount: 16.53,
        transactionDate: "2026-05-02",
        status: "Draft",
        memo: "",
        reviewUrl: "https://app.ramp.com/details/reimbursements/existing/draft",
        rampReportId: "existing",
      },
    ]);

    const tool = createReimbursementAutomationTools()[0];
    if (!tool) throw new Error("Missing tool");

    const blocked = await tool.handler({
      action: "prepare_ramp_reimbursement_draft",
      amount: 16.53,
      transaction_date: "2026-05-02",
      memo: "Exec Buy Back Time",
      evidence_path: "/tmp/walmart.png",
      merchant: "Walmart",
    });

    expect(manager.prepareRampReimbursementDraft).not.toHaveBeenCalled();
    expect(blocked).toEqual(expect.objectContaining({
      error: expect.stringContaining("prepare_ramp_reimbursement_draft blocked by dedup gate"),
      dedup: expect.objectContaining({
        duplicate: true,
        reasons: expect.arrayContaining(["matching_ramp_history"]),
        historyMatches: expect.arrayContaining([
          expect.objectContaining({
            status: "Draft",
            reviewUrl: "https://app.ramp.com/details/reimbursements/existing/draft",
          }),
        ]),
      }),
    }));
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

  it("syncs Walmart receipt tracking after a Ramp draft is prepared", async () => {
    manager.prepareRampReimbursementDraft.mockResolvedValue({
      reviewUrl: "https://app.ramp.com/details/reimbursements/abc/review",
      rampReportId: "abc",
      amount: 41.03,
      transactionDate: "04/01/2026",
      memo: "Exec Buy Back Time",
      evidencePath: "/tmp/archive/walmart-tip.png",
    });
    evidence.loadReimbursementEvidenceRecord.mockReturnValue({
      orderId: "2000146-86460984",
      archivedPath: "/tmp/archive/walmart-tip.png",
    });
    registry.findWalmartReceiptRecord.mockReturnValue({
      filePath: "/tmp/receipt.md",
      orderId: "2000146-86460984",
      reimbursement: {},
    });

    const tool = createReimbursementAutomationTools()[0];
    if (!tool) throw new Error("Missing tool");

    await tool.handler({
      action: "submit_ramp_reimbursement",
      amount: 41.03,
      transaction_date: "2026-04-01",
      memo: "Exec Buy Back Time",
      evidence_path: "/tmp/walmart-tip.png",
      merchant: "Walmart",
    });

    expect(registry.upsertWalmartReimbursementTracking).toHaveBeenCalledWith(
      expect.objectContaining({
        notePath: "/tmp/receipt.md",
        status: "draft",
        system: "Ramp",
        reimbursableItem: "Driver tip",
        amount: 41.03,
        note: "Exec Buy Back Time",
        evidencePath: "/tmp/archive/walmart-tip.png",
        rampReportId: "abc",
        submitted: "",
      }),
    );
  });

  it("syncs Walmart receipt tracking by date and amount when evidence lacks an order id", async () => {
    manager.prepareRampReimbursementDraft.mockResolvedValue({
      reviewUrl: "https://app.ramp.com/details/reimbursements/abc/review",
      rampReportId: "abc",
      amount: 28.9,
      transactionDate: "2026-05-09",
      memo: "Exec Buy Back Time",
      evidencePath: "/tmp/archive/walmart-tip.png",
    });
    evidence.loadReimbursementEvidenceRecord.mockReturnValue({
      archivedPath: "/tmp/archive/walmart-tip.png",
    });
    registry.listWalmartDeliveryCandidates.mockReturnValue([
      {
        filePath: "/tmp/2026-05-09 Order 2000146-30847351.md",
        orderId: "2000146-30847351",
        date: "2026-05-09",
        driverTip: 28.9,
        reimbursement: {},
      },
    ]);

    const tool = createReimbursementAutomationTools()[0];
    if (!tool) throw new Error("Missing tool");

    await tool.handler({
      action: "prepare_ramp_reimbursement_draft",
      amount: 28.9,
      transaction_date: "2026-05-09",
      memo: "Exec Buy Back Time",
      evidence_path: "/tmp/walmart-tip.png",
      merchant: "Walmart",
    });

    expect(registry.listWalmartDeliveryCandidates).toHaveBeenCalledWith({
      since: "2026-05-09",
      includeSubmitted: true,
    });
    expect(registry.upsertWalmartReimbursementTracking).toHaveBeenCalledWith(
      expect.objectContaining({
        notePath: "/tmp/2026-05-09 Order 2000146-30847351.md",
        status: "draft",
        amount: 28.9,
        note: "Exec Buy Back Time",
        evidencePath: "/tmp/archive/walmart-tip.png",
        rampReportId: "abc",
      }),
    );
  });

  it("requires an explicit confirmation token before submitting a reviewed Ramp draft", async () => {
    const tool = createReimbursementAutomationTools()[0];
    if (!tool) throw new Error("Missing tool");

    const result = await tool.handler({
      action: "submit_reviewed_ramp_reimbursement",
      review_url: "https://app.ramp.com/details/reimbursements/abc/draft",
      amount: 41.03,
      transaction_date: "2026-04-01",
      memo: "Exec Buy Back Time",
      merchant: "Walmart",
    });

    expect(manager.submitReviewedRampReimbursement).not.toHaveBeenCalled();
    expect(result).toEqual({
      error: "submit_reviewed_ramp_reimbursement requires submission_confirmation=DEVIN_REVIEWED_AND_APPROVED_SUBMISSION after Devin explicitly approves submission",
    });
  });

  it("submits a reviewed Ramp draft only after expected fields and confirmation are supplied", async () => {
    manager.submitReviewedRampReimbursement.mockResolvedValue({
      reviewUrl: "https://app.ramp.com/details/reimbursements/abc/review",
      rampReportId: "abc",
      amount: 41.03,
      transactionDate: "04/01/2026",
      memo: "Exec Buy Back Time",
      merchant: "Walmart",
    });

    const tool = createReimbursementAutomationTools()[0];
    if (!tool) throw new Error("Missing tool");

    const result = await tool.handler({
      action: "submit_reviewed_ramp_reimbursement",
      review_url: "https://app.ramp.com/details/reimbursements/abc/draft",
      submission_confirmation: "DEVIN_REVIEWED_AND_APPROVED_SUBMISSION",
      amount: 41.03,
      transaction_date: "2026-04-01",
      memo: "Exec Buy Back Time",
      merchant: "Walmart",
      evidence_path: "/tmp/archive/walmart-tip.png",
    });

    expect(manager.submitReviewedRampReimbursement).toHaveBeenCalledWith({
      reviewUrl: "https://app.ramp.com/details/reimbursements/abc/draft",
      amount: 41.03,
      transactionDate: "2026-04-01",
      memo: "Exec Buy Back Time",
      merchant: "Walmart",
      evidencePath: "/tmp/archive/walmart-tip.png",
    });
    expect(result).toEqual({
      result: {
        reviewUrl: "https://app.ramp.com/details/reimbursements/abc/review",
        rampReportId: "abc",
        amount: 41.03,
        transactionDate: "04/01/2026",
        memo: "Exec Buy Back Time",
        merchant: "Walmart",
      },
      message: "Ramp reimbursement submitted after review check: https://app.ramp.com/details/reimbursements/abc/review",
    });
  });

  it("repairs an existing Ramp draft in place", async () => {
    manager.repairRampReimbursementDraft.mockResolvedValue({
      reviewUrl: "https://app.ramp.com/details/reimbursements/maid/draft",
      rampReportId: "maid",
      amount: 350,
      transactionDate: "05/01/2026",
      memo: "Exec Buy Back Time",
      merchant: "Maid in Newport",
      evidencePath: "/tmp/archive/maid.pdf",
    });

    const tool = createReimbursementAutomationTools()[0];
    if (!tool) throw new Error("Missing tool");

    const result = await tool.handler({
      action: "repair_ramp_reimbursement_draft",
      review_url: "https://app.ramp.com/details/reimbursements/maid/draft",
      amount: 350,
      transaction_date: "2026-05-01",
      evidence_path: "/tmp/maid.pdf",
      vendor: "maid_in_newport",
    });

    expect(manager.repairRampReimbursementDraft).toHaveBeenCalledWith({
      reviewUrl: "https://app.ramp.com/details/reimbursements/maid/draft",
      amount: 350,
      transactionDate: "2026-05-01",
      memo: "Exec Buy Back Time",
      merchant: "Maid in Newport",
      evidencePath: "/tmp/maid.pdf",
    });
    expect(result).toEqual({
      result: {
        reviewUrl: "https://app.ramp.com/details/reimbursements/maid/draft",
        rampReportId: "maid",
        amount: 350,
        transactionDate: "05/01/2026",
        memo: "Exec Buy Back Time",
        merchant: "Maid in Newport",
        evidencePath: "/tmp/archive/maid.pdf",
      },
      draftUrl: "https://app.ramp.com/details/reimbursements/maid/draft",
      message: "Ramp reimbursement draft repaired for manual review at https://app.ramp.com/details/reimbursements/maid/draft. It has not been submitted.",
    });
  });
});
