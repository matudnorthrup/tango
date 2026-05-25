import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
