import { beforeEach, describe, expect, it, vi } from "vitest";

const { manager, registry } = vi.hoisted(() => ({
  manager: {
    launch: vi.fn(),
    discoverWalmartDeliveryCandidates: vi.fn(),
    listRampReimbursementHistory: vi.fn(),
  },
  registry: {
    listWalmartDeliveryCandidates: vi.fn(),
    findWalmartReceiptRecord: vi.fn(),
    backfillWalmartReceiptNote: vi.fn(),
    reconcileWalmartReimbursementsAgainstRamp: vi.fn(),
    upsertWalmartReimbursementTracking: vi.fn(),
  },
}));

vi.mock("../src/browser-manager.js", () => ({
  getBrowserManager: () => manager,
}));

vi.mock("../src/receipt-reimbursement-registry.js", () => registry);

import { createReceiptRegistryTools } from "../src/personal-agent-tools.js";

describe("personal-agent-tools receipt registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    manager.launch.mockResolvedValue("Connected");
    manager.listRampReimbursementHistory.mockResolvedValue([]);
    registry.reconcileWalmartReimbursementsAgainstRamp.mockReturnValue({
      records: [],
      matched: [],
      pending: [],
      unverifiedSubmitted: [],
      updated: [],
      notesExamined: 0,
      historyEntriesExamined: 0,
    });
  });

  it("can backfill Walmart delivery candidates from live order history", async () => {
    manager.discoverWalmartDeliveryCandidates.mockResolvedValue([
      {
        orderId: "2000139-64770733",
        orderUrl: "https://www.walmart.com/orders/200013964770733",
        date: "2025-10-16",
        dateText: "Oct 16, 2025",
        driverTip: 26.67,
        notes: "Delivery from store. Delivered on Oct 16, 2025. Driver tip $26.67 charged separately after delivery.",
      },
    ]);
    registry.findWalmartReceiptRecord.mockReturnValue(null);
    registry.backfillWalmartReceiptNote.mockReturnValue({
      filePath: "/tmp/2025-10-16 Order 2000139-64770733.md",
      reimbursement: {},
    });
    registry.reconcileWalmartReimbursementsAgainstRamp.mockReturnValue({
      records: [],
      matched: [],
      pending: [
        {
          orderId: "2000139-64770733",
        },
      ],
      unverifiedSubmitted: [],
      updated: [],
      notesExamined: 1,
      historyEntriesExamined: 1,
    });

    const tool = createReceiptRegistryTools()[0];
    if (!tool) throw new Error("Missing tool");

    const result = await tool.handler({
      action: "backfill_walmart_delivery_candidates",
      since: "2025-09-01",
      until: "2025-12-31",
      max_pages: 6,
    });

    expect(manager.launch).toHaveBeenCalledWith(9223);
    expect(manager.discoverWalmartDeliveryCandidates).toHaveBeenCalledWith({
      since: "2025-09-01",
      until: "2025-12-31",
      maxPages: 6,
    });
    expect(manager.listRampReimbursementHistory).toHaveBeenCalledWith({
      maxPages: 6,
    });
    expect(registry.backfillWalmartReceiptNote).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "2000139-64770733",
        date: "2025-10-16",
        driverTip: 26.67,
      }),
    );
    expect(result).toEqual({
      retailer: "Walmart",
      verified_with_ramp: true,
      results: [
        expect.objectContaining({
          orderId: "2000139-64770733",
          reimbursement_status: "not_submitted",
          note_path: "/tmp/2025-10-16 Order 2000139-64770733.md",
        }),
      ],
      verification: {
        notes_examined: 1,
        history_entries_examined: 1,
        matched: [],
        unverified_submitted: [],
      },
    });
  });

  it("can reconcile Walmart reimbursement notes against live Ramp history", async () => {
    registry.reconcileWalmartReimbursementsAgainstRamp.mockReturnValue({
      records: [],
      matched: [
        {
          orderId: "2000146-86460984",
          noteStatusBefore: "not_submitted",
          noteStatusAfter: "reimbursed",
        },
      ],
      pending: [
        {
          orderId: "2000143-77828633",
        },
      ],
      unverifiedSubmitted: [],
      updated: [
        {
          orderId: "2000146-86460984",
          reimbursement: { status: "reimbursed" },
        },
      ],
      notesExamined: 2,
      historyEntriesExamined: 6,
    });

    const tool = createReceiptRegistryTools()[0];
    if (!tool) throw new Error("Missing tool");

    const result = await tool.handler({
      action: "reconcile_walmart_reimbursements",
      since: "2026-04-01",
      max_pages: 3,
    });

    expect(manager.launch).toHaveBeenCalledWith(9223);
    expect(manager.listRampReimbursementHistory).toHaveBeenCalledWith({
      maxPages: 3,
    });
    expect(result).toEqual({
      retailer: "Walmart",
      verified_with_ramp: true,
      matched: [
        {
          orderId: "2000146-86460984",
          noteStatusBefore: "not_submitted",
          noteStatusAfter: "reimbursed",
        },
      ],
      updated: [
        {
          orderId: "2000146-86460984",
          reimbursement: { status: "reimbursed" },
        },
      ],
      pending: [
        {
          orderId: "2000143-77828633",
        },
      ],
      unverified_submitted: [],
      notes_examined: 2,
      history_entries_examined: 6,
    });
  });
});
