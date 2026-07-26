import { beforeEach, describe, expect, it, vi } from "vitest";

const manager = {
  launch: vi.fn(),
  connect: vi.fn(),
  status: vi.fn(),
  close: vi.fn(),
  open: vi.fn(),
  snapshot: vi.fn(),
  screenshot: vi.fn(),
  click: vi.fn(),
  fill: vi.fn(),
  upload: vi.fn(),
  type: vi.fn(),
  press: vi.fn(),
  select: vi.fn(),
  scroll: vi.fn(),
  wait: vi.fn(),
  evaluate: vi.fn(),
};

const churchSession = vi.hoisted(() => ({ ensureChurchSession: vi.fn() }));

vi.mock("../src/browser-manager.js", () => ({
  getBrowserManager: () => manager,
  describeBrowserProfile: () => ({ expected: "/tmp/profile", actual: "/tmp/profile", matches: true }),
}));

vi.mock("../src/church-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/church-session.js")>();
  return { ...actual, ensureChurchSession: churchSession.ensureChurchSession };
});

import { createBrowserTools } from "../src/browser-agent-tools.js";

describe("browser-agent-tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    churchSession.ensureChurchSession.mockResolvedValue({
      scope: "lcr",
      authenticated: true,
      needsLogin: false,
      path: "silent-sso",
      steps: [],
      probe: { scope: "lcr", authenticated: true, needsLogin: false, inconclusive: false, detail: "ok" },
      message: "Church lcr session was restored from the existing single sign-on session.",
    });
  });

  it("auto-launches and connects before page actions when disconnected", async () => {
    manager.status.mockResolvedValue({ connected: false });
    manager.launch.mockResolvedValue("Connected.");
    manager.open.mockResolvedValue("Opened.");

    const tool = createBrowserTools()[0];
    if (!tool) throw new Error("Missing browser tool");

    const result = await tool.handler({
      action: "open",
      url: "https://www.walmart.com/",
    });

    expect(manager.status).toHaveBeenCalledTimes(1);
    expect(manager.launch).toHaveBeenCalledWith(9223);
    expect(manager.open).toHaveBeenCalledWith("https://www.walmart.com/");
    expect(result).toEqual({ result: "Opened." });
  });

  it("does not relaunch when already connected", async () => {
    manager.status.mockResolvedValue({ connected: true, url: "https://www.walmart.com/" });
    manager.snapshot.mockResolvedValue("# Walmart");

    const tool = createBrowserTools()[0];
    if (!tool) throw new Error("Missing browser tool");

    const result = await tool.handler({
      action: "snapshot",
      interactive: true,
    });

    expect(manager.status).toHaveBeenCalledTimes(1);
    expect(manager.launch).not.toHaveBeenCalled();
    expect(manager.snapshot).toHaveBeenCalledWith({ interactive: true });
    expect(result).toEqual({ result: "# Walmart" });
  });

  it("passes screenshot selector and ref through to the browser manager", async () => {
    manager.status.mockResolvedValue({ connected: true, url: "https://www.walmart.com/orders" });
    manager.screenshot.mockResolvedValue("/tmp/tango-screenshot-test.png");

    const tool = createBrowserTools()[0];
    if (!tool) throw new Error("Missing browser tool");

    const result = await tool.handler({
      action: "screenshot",
      ref: 12,
      selector: "text=Driver tip",
    });

    expect(manager.screenshot).toHaveBeenCalledWith({
      fullPage: false,
      ref: 12,
      selector: "text=Driver tip",
    });
    expect(result).toMatchObject({ screenshot_path: "/tmp/tango-screenshot-test.png" });
    expect(String((result as Record<string, unknown>).note)).toContain("discord_send_image");
  });

  it("passes upload files through to the browser manager", async () => {
    manager.status.mockResolvedValue({ connected: true, url: "https://app.ramp.com/details/reimbursements/new" });
    manager.upload.mockResolvedValue("Uploaded 1 file(s) into [23]");

    const tool = createBrowserTools()[0];
    if (!tool) throw new Error("Missing browser tool");

    const result = await tool.handler({
      action: "upload",
      ref: 23,
      files: ["/tmp/tango-screenshot-test.png"],
    });

    expect(manager.upload).toHaveBeenCalledWith(23, ["/tmp/tango-screenshot-test.png"]);
    expect(result).toEqual({ result: "Uploaded 1 file(s) into [23]" });
  });

  it("signs in to Church sites before navigating so LCR work never lands on a sign-in page", async () => {
    manager.status.mockResolvedValue({ connected: true, url: "about:blank" });
    manager.open.mockResolvedValue("Opened.");

    const tool = createBrowserTools()[0];
    if (!tool) throw new Error("Missing browser tool");

    const result = await tool.handler({
      action: "open",
      url: "https://lcr.churchofjesuschrist.org/mlt/records/member-list?lang=eng",
    });

    expect(churchSession.ensureChurchSession).toHaveBeenCalledWith({
      url: "https://lcr.churchofjesuschrist.org/mlt/records/member-list?lang=eng",
    });
    expect(result).toMatchObject({
      result: "Opened.",
      church_session: { authenticated: true, path: "silent-sso" },
    });
  });

  it("leaves non-Church navigation untouched", async () => {
    manager.status.mockResolvedValue({ connected: true, url: "about:blank" });
    manager.open.mockResolvedValue("Opened.");

    const tool = createBrowserTools()[0];
    if (!tool) throw new Error("Missing browser tool");

    const result = await tool.handler({ action: "open", url: "https://www.walmart.com/" });

    expect(churchSession.ensureChurchSession).not.toHaveBeenCalled();
    expect(result).toEqual({ result: "Opened." });
  });
});
