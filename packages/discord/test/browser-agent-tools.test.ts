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

vi.mock("../src/browser-manager.js", () => ({
  getBrowserManager: () => manager,
}));

import { createBrowserTools } from "../src/browser-agent-tools.js";

describe("browser-agent-tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(result).toEqual({ screenshot_path: "/tmp/tango-screenshot-test.png" });
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
});
