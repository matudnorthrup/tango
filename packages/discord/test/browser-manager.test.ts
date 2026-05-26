import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildBrowserLaunchArgs,
  parseRampHistoryRecordFromRow,
  rampDateTextMatchesInput,
  rampMerchantTextMatchesInput,
  resolveBrowserProfileDir,
} from "../src/browser-manager.js";

describe("browser-manager launch config", () => {
  const originalProfileDir = process.env.TANGO_BROWSER_PROFILE_DIR;
  const originalDataDir = process.env.TANGO_DATA_DIR;
  const originalHome = process.env.TANGO_HOME;
  const originalProfile = process.env.TANGO_PROFILE;
  const originalCwd = process.cwd();
  const tempDirs: string[] = [];

  afterEach(() => {
    process.chdir(originalCwd);
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    if (originalProfileDir === undefined) {
      delete process.env.TANGO_BROWSER_PROFILE_DIR;
    } else {
      process.env.TANGO_BROWSER_PROFILE_DIR = originalProfileDir;
    }
    if (originalDataDir === undefined) {
      delete process.env.TANGO_DATA_DIR;
    } else {
      process.env.TANGO_DATA_DIR = originalDataDir;
    }
    if (originalHome === undefined) {
      delete process.env.TANGO_HOME;
    } else {
      process.env.TANGO_HOME = originalHome;
    }
    if (originalProfile === undefined) {
      delete process.env.TANGO_PROFILE;
    } else {
      process.env.TANGO_PROFILE = originalProfile;
    }
  });

  it("uses a persistent default browser profile dir under data/browser-profile", () => {
    delete process.env.TANGO_BROWSER_PROFILE_DIR;
    expect(resolveBrowserProfileDir()).toMatch(/data\/browser-profile$/);
  });

  it("honors TANGO_BROWSER_PROFILE_DIR override", () => {
    process.env.TANGO_BROWSER_PROFILE_DIR = "/tmp/tango-browser-profile";
    expect(resolveBrowserProfileDir()).toBe("/tmp/tango-browser-profile");
  });

  it("uses the configured Tango data dir when no explicit browser profile override is set", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-browser-home-"));
    tempDirs.push(homeDir);
    delete process.env.TANGO_BROWSER_PROFILE_DIR;
    process.env.TANGO_HOME = homeDir;
    process.env.TANGO_PROFILE = "default";
    process.env.TANGO_DATA_DIR = path.join(homeDir, "profiles", "default", "data");

    expect(resolveBrowserProfileDir()).toBe(
      path.join(homeDir, "profiles", "default", "data", "browser-profile"),
    );
  });

  it("builds launch args with remote debugging and dedicated profile", () => {
    const args = buildBrowserLaunchArgs(9223, "/tmp/tango-browser-profile");
    expect(args).toEqual([
      "--remote-debugging-port=9223",
      "--remote-debugging-address=127.0.0.1",
      "--user-data-dir=/tmp/tango-browser-profile",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ]);
  });

  it("parses current Ramp reimbursement rows including drafts", () => {
    const draft = parseRampHistoryRecordFromRow({
      reviewUrl: "https://app.ramp.com/details/reimbursements/4324/draft",
      cells: [
        "",
        "",
        "WalmartDraft",
        "$16.53 USD",
        "May 2, 2026",
        "—",
        "None",
        "",
        "—",
        "—",
        "",
        "—",
        "Submit",
        "",
      ],
    });

    expect(draft).toMatchObject({
      reviewUrl: "https://app.ramp.com/details/reimbursements/4324/draft",
      rampReportId: "4324",
      status: "Draft",
      merchant: "Walmart",
      amount: 16.53,
      transactionDate: "2026-05-02",
    });

    const paid = parseRampHistoryRecordFromRow({
      reviewUrl: "https://app.ramp.com/details/reimbursements/c179",
      cells: [
        "",
        "",
        "WalmartPaid · Devin Northrup's account x-6242",
        "$27.19 USD",
        "Apr 10, 2026",
        "Apr 16, 2026",
        "None",
        "",
        "Exec Buy Back Time",
        "—",
        "",
        "—",
        "—",
        "",
      ],
    });

    expect(paid).toMatchObject({
      status: "Paid",
      merchant: "Walmart",
      entity: "Devin Northrup's account x-6242",
      amount: 27.19,
      transactionDate: "2026-04-10",
      submittedDate: "2026-04-16",
      memo: "Exec Buy Back Time",
    });

    const pending = parseRampHistoryRecordFromRow({
      reviewUrl: "https://app.ramp.com/details/reimbursements/52a796e6-3f32-4aa7-9b4b-953d06ca3a28",
      cells: [
        "",
        "",
        "Maid in NewportAwaiting reviewer",
        "$350.00 USD",
        "May 1, 2026",
        "May 25, 2026",
        "None",
        "",
        "Exec Buy Back Time",
        "—",
        "",
        "—",
        "—",
        "",
      ],
    });

    expect(pending).toMatchObject({
      rampReportId: "52a796e6-3f32-4aa7-9b4b-953d06ca3a28",
      status: "Awaiting reviewer",
      merchant: "Maid in Newport",
      amount: 350,
      transactionDate: "2026-05-01",
      submittedDate: "2026-05-25",
      memo: "Exec Buy Back Time",
    });
  });

  it("recognizes when Ramp already OCR-filled the requested merchant", () => {
    expect(rampMerchantTextMatchesInput("Walmart", "walmart")).toBe(true);
    expect(rampMerchantTextMatchesInput("Walmart", "Walmart - delivery tip")).toBe(true);
    expect(rampMerchantTextMatchesInput("Venmo", "Venmo reimbursement")).toBe(true);
    expect(rampMerchantTextMatchesInput("Maid in Newport", "Walmart")).toBe(false);
    expect(rampMerchantTextMatchesInput(undefined, "Walmart")).toBe(false);
  });

  it("accepts Ramp date display formats during draft verification", () => {
    expect(rampDateTextMatchesInput("May 2, 2026", "2026-05-02")).toBe(true);
    expect(rampDateTextMatchesInput("05/02/2026", "2026-05-02")).toBe(true);
    expect(rampDateTextMatchesInput("May 3, 2026", "2026-05-02")).toBe(false);
  });
});
