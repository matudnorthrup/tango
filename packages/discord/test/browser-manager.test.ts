import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBrowserLaunchArgs, resolveBrowserProfileDir } from "../src/browser-manager.js";

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
});
