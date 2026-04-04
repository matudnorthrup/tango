import { getBrowserManager } from "../packages/discord/src/browser-manager.ts";
import {
  backfillWalmartReceiptNote,
  findWalmartReceiptRecord,
} from "../packages/discord/src/receipt-reimbursement-registry.ts";

function getArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

function parseBooleanFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function buildYearlyWindows(since: string, until: string): Array<{ since: string; until: string }> {
  const startYear = Number.parseInt(since.slice(0, 4), 10);
  const endYear = Number.parseInt(until.slice(0, 4), 10);
  if (!Number.isFinite(startYear) || !Number.isFinite(endYear) || endYear < startYear) {
    return [{ since, until }];
  }

  const windows: Array<{ since: string; until: string }> = [];
  for (let year = startYear; year <= endYear; year += 1) {
    windows.push({
      since: year === startYear ? since : `${year}-01-01`,
      until: year === endYear ? until : `${year}-12-31`,
    });
  }
  return windows;
}

async function main(): Promise<void> {
  const since = getArg("--since") ?? "2025-09-01";
  const until = getArg("--until") ?? new Date().toISOString().slice(0, 10);
  const maxPages = Number.parseInt(getArg("--max-pages") ?? "8", 10);
  const backfillMissing = parseBooleanFlag("--backfill-missing");

  const browser = getBrowserManager();
  await browser.launch(9223);

  const windows = buildYearlyWindows(since, until);
  const discoveredByOrderId = new Map<string, Awaited<ReturnType<typeof browser.discoverWalmartDeliveryCandidates>>[number]>();
  for (const window of windows) {
    const discovered = await browser.discoverWalmartDeliveryCandidates({
      since: window.since,
      until: window.until,
      maxPages: Number.isFinite(maxPages) ? maxPages : 8,
    });
    for (const candidate of discovered) {
      discoveredByOrderId.set(candidate.orderId, candidate);
    }
  }
  const discovered = [...discoveredByOrderId.values()].sort((left, right) => left.date.localeCompare(right.date));

  const results = discovered.map((candidate) => {
    const existing = findWalmartReceiptRecord(candidate.orderId);
    const record = existing ?? (
      backfillMissing
        ? backfillWalmartReceiptNote({
          orderId: candidate.orderId,
          date: candidate.date,
          total: candidate.total,
          cardCharge: candidate.cardCharge,
          itemsLine: candidate.itemsLine,
          grocerySummary: "Walmart grocery delivery. Full item breakdown not yet backfilled into the note.",
          notes: candidate.notes,
          driverTip: candidate.driverTip,
        })
        : null
    );

    const reimbursement = record?.reimbursement ?? {};
    return {
      orderId: candidate.orderId,
      date: candidate.date,
      driverTip: candidate.driverTip,
      orderUrl: candidate.orderUrl,
      notePath: record?.filePath ?? null,
      reimbursementStatus: reimbursement.status ?? null,
      rampReportId: reimbursement.rampReportId ?? null,
      evidencePath: reimbursement.evidencePath ?? null,
      missingNote: !record,
    };
  });

  const summary = {
    since,
    until,
    maxPages: Number.isFinite(maxPages) ? maxPages : 8,
    windows,
    discoveredCount: discovered.length,
    missingNoteCount: results.filter((item) => item.missingNote).length,
    submittedCount: results.filter((item) => item.reimbursementStatus === "submitted").length,
    reimbursedCount: results.filter((item) => item.reimbursementStatus === "reimbursed").length,
    pendingCount: results.filter((item) =>
      item.reimbursementStatus == null
      || item.reimbursementStatus === "not_submitted"
      || item.reimbursementStatus === "skipped"
    ).length,
  };

  console.log(JSON.stringify({ summary, results }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
