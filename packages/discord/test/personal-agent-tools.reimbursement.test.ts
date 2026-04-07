import { beforeEach, describe, expect, it, vi } from "vitest";

const manager = {
  launch: vi.fn(),
  captureWalmartTipEvidence: vi.fn(),
  captureEmailReimbursementEvidence: vi.fn(),
  submitRampReimbursement: vi.fn(),
  replaceRampReimbursementReceipt: vi.fn(),
};

vi.mock("../src/browser-manager.js", () => ({
  getBrowserManager: () => manager,
}));

import { createReimbursementAutomationTools } from "../src/personal-agent-tools.js";

describe("personal-agent-tools reimbursement automation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    manager.launch.mockResolvedValue("Connected");
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
    expect(result).toEqual({
      result: {
        reviewUrl: "https://app.ramp.com/details/reimbursements/abc/review",
        rampReportId: "abc",
        amount: 27.38,
        transactionDate: "03/08/2026",
        memo: "executive buy back time",
      },
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
});
