import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const manager = {
  launch: vi.fn(),
  status: vi.fn(),
  open: vi.fn(),
  evaluate: vi.fn(),
  wait: vi.fn(),
};

vi.mock("../src/op-secret.js", () => ({
  getSecret: vi.fn(),
  getOneTimePassword: vi.fn(),
  isOpAvailable: vi.fn(),
}));

vi.mock("../src/browser-manager.js", () => ({
  getBrowserManager: () => manager,
}));

import { getOneTimePassword, getSecret, isOpAvailable } from "../src/op-secret.js";
import {
  createGospelLibraryTools,
  gospelLibraryActionLooksMutating,
} from "../src/gospel-library-agent-tools.js";

const getSecretMock = vi.mocked(getSecret);
const getOneTimePasswordMock = vi.mocked(getOneTimePassword);
const isOpAvailableMock = vi.mocked(isOpAvailable);

describe("gospel-library-agent-tools", () => {
  const originalChurchVault = process.env.CHURCH_ACCOUNT_1PASSWORD_VAULT;
  const originalChurchItem = process.env.CHURCH_ACCOUNT_1PASSWORD_ITEM;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CHURCH_ACCOUNT_1PASSWORD_VAULT = "ChurchVault";
    process.env.CHURCH_ACCOUNT_1PASSWORD_ITEM = "ChurchItem";
    isOpAvailableMock.mockReturnValue(true);
    getOneTimePasswordMock.mockResolvedValue(null);
    getSecretMock.mockImplementation(async (_vault, _item, field) => {
      if (field === "username") return "devin@example.test";
      if (field === "password") return "correct horse battery staple";
      return null;
    });
  });

  afterEach(() => {
    if (originalChurchVault === undefined) {
      delete process.env.CHURCH_ACCOUNT_1PASSWORD_VAULT;
    } else {
      process.env.CHURCH_ACCOUNT_1PASSWORD_VAULT = originalChurchVault;
    }
    if (originalChurchItem === undefined) {
      delete process.env.CHURCH_ACCOUNT_1PASSWORD_ITEM;
    } else {
      process.env.CHURCH_ACCOUNT_1PASSWORD_ITEM = originalChurchItem;
    }
  });

  it("launches and opens Gospel Library during status instead of asking for a browser tab", async () => {
    manager.status
      .mockResolvedValueOnce({ connected: false })
      .mockResolvedValueOnce({ connected: true, url: "about:blank" })
      .mockResolvedValueOnce({ connected: true, url: "https://www.churchofjesuschrist.org/study/scriptures?lang=eng" })
      .mockResolvedValueOnce({ connected: true, url: "https://www.churchofjesuschrist.org/study/scriptures?lang=eng" });
    manager.launch.mockResolvedValue("Connected.");
    manager.open.mockResolvedValue("Opened.");
    manager.evaluate.mockResolvedValue({
      ok: true,
      status: 200,
      url: "https://www.churchofjesuschrist.org/notes/api/v3/annotations?type=reference&locale=eng&docId=128394547",
      body: [{ id: "private-annotation-id" }],
    });

    const tool = createGospelLibraryTools()[0];
    if (!tool) throw new Error("Missing gospel_library tool");

    const result = await tool.handler({ action: "status" });

    expect(manager.launch).toHaveBeenCalledWith(9223);
    expect(manager.open).toHaveBeenCalledWith("https://www.churchofjesuschrist.org/study/scriptures?lang=eng");
    expect(manager.evaluate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      connected: true,
      launched: true,
      navigated: true,
      onChurchSite: true,
      authenticated: true,
      needsLogin: false,
      probe: {
        ok: true,
        status: 200,
        bodySummary: {
          type: "array",
          count: 1,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("private-annotation-id");
  });

  it("prepares the Church sign-in flow when annotations are unauthenticated", async () => {
    manager.status
      .mockResolvedValueOnce({ connected: true, url: "about:blank" })
      .mockResolvedValueOnce({ connected: true, url: "about:blank" })
      .mockResolvedValueOnce({ connected: true, url: "https://www.churchofjesuschrist.org/study/scriptures?lang=eng" })
      .mockResolvedValueOnce({ connected: true, url: "https://id.churchofjesuschrist.org/login" });
    manager.open.mockResolvedValue("Opened.");
    manager.wait.mockResolvedValue("Waited.");
    manager.evaluate
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        url: "https://www.churchofjesuschrist.org/notes/api/v3/annotations?type=reference&locale=eng&docId=128394547",
        body: "Sign in required",
      })
      .mockResolvedValueOnce({
        url: "https://www.churchofjesuschrist.org/study/scriptures?lang=eng",
        hasPasswordField: false,
        controls: [{ text: "Sign In", href: "https://id.churchofjesuschrist.org/login" }],
      })
      .mockResolvedValueOnce({
        clicked: true,
        text: "Sign In",
        href: "https://id.churchofjesuschrist.org/login",
      })
      .mockResolvedValueOnce({
        url: "https://id.churchofjesuschrist.org/login",
        hasPasswordField: true,
      });

    const tool = createGospelLibraryTools()[0];
    if (!tool) throw new Error("Missing gospel_library tool");

    const result = await tool.handler({ action: "prepare_login" });

    expect(manager.open).toHaveBeenCalledWith("https://www.churchofjesuschrist.org/study/scriptures?lang=eng");
    expect(manager.wait).toHaveBeenCalledWith({ timeout: 2500 });
    expect(result).toMatchObject({
      connected: true,
      authenticated: false,
      needsLogin: true,
      currentUrl: "https://id.churchofjesuschrist.org/login",
      click: {
        clicked: true,
        text: "Sign In",
      },
    });
  });

  it("logs in with the configured 1Password Church item without returning secrets", async () => {
    manager.status.mockResolvedValue({
      connected: true,
      url: "https://www.churchofjesuschrist.org/study/scriptures?lang=eng",
    });
    manager.wait.mockResolvedValue("Waited.");
    let probeCount = 0;
    manager.evaluate.mockImplementation(async (script: string) => {
      if (script.includes("fetch(")) {
        probeCount += 1;
        return probeCount === 1
          ? {
              ok: false,
              status: 401,
              url: "https://www.churchofjesuschrist.org/notes/api/v3/annotations?type=reference&locale=eng&docId=128394547",
              body: "Sign in required",
            }
          : {
              ok: true,
              status: 200,
              url: "https://www.churchofjesuschrist.org/notes/api/v3/annotations?type=reference&locale=eng&docId=128394547",
              body: [{ id: "private-annotation-id" }],
            };
      }
      if (script.includes("suppliedUsername")) {
        return {
          url: "https://id.churchofjesuschrist.org/login",
          usernameFieldFound: true,
          passwordFieldFound: true,
          filledUsername: true,
          filledPassword: true,
          clicked: true,
          submittedViaForm: false,
        };
      }
      if (script.includes("hasPasswordField")) {
        return {
          url: "https://id.churchofjesuschrist.org/login",
          hasUsernameField: true,
          hasPasswordField: true,
          hasOtpField: false,
          bodySignals: {},
        };
      }
      return { clicked: true, text: "Sign In" };
    });

    const tool = createGospelLibraryTools()[0];
    if (!tool) throw new Error("Missing gospel_library tool");

    const result = await tool.handler({ action: "login" });

    expect(getSecretMock).toHaveBeenCalledWith("ChurchVault", "ChurchItem", "username");
    expect(getSecretMock).toHaveBeenCalledWith("ChurchVault", "ChurchItem", "password");
    expect(result).toMatchObject({
      authenticated: true,
      needsLogin: false,
      credentialSource: "onepassword",
      credentialReady: true,
      finalProbe: {
        ok: true,
        status: 200,
        bodySummary: {
          type: "array",
          count: 1,
        },
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("devin@example.test");
    expect(serialized).not.toContain("correct horse battery staple");
    expect(serialized).not.toContain("private-annotation-id");
  });

  it("opens the Study login flow when the notes token is expired but no sign-in control is visible", async () => {
    manager.status.mockResolvedValue({
      connected: true,
      url: "https://www.churchofjesuschrist.org/study/scriptures/bofm/2-ne/3?lang=eng",
    });
    manager.open.mockResolvedValue("Opened.");
    manager.wait.mockResolvedValue("Waited.");
    let probeCount = 0;
    let pageStateCount = 0;
    manager.evaluate.mockImplementation(async (script: string) => {
      if (script.includes("fetch(")) {
        probeCount += 1;
        return probeCount === 1
          ? {
              ok: false,
              status: 401,
              url: "https://www.churchofjesuschrist.org/notes/api/v3/annotations?type=reference&locale=eng&docId=128394547",
              body: "Could not verify token",
            }
          : {
              ok: true,
              status: 200,
              url: "https://www.churchofjesuschrist.org/notes/api/v3/annotations?type=reference&locale=eng&docId=128394547",
              body: [],
            };
      }
      if (script.includes("hasPasswordField")) {
        pageStateCount += 1;
        return pageStateCount === 1
          ? {
              url: "https://www.churchofjesuschrist.org/study/scriptures/bofm/2-ne/3?lang=eng",
              hasUsernameField: false,
              hasPasswordField: false,
              hasOtpField: false,
              bodySignals: {},
              controls: [],
            }
          : {
              url: "https://id.churchofjesuschrist.org/oauth2/default/v1/authorize",
              hasUsernameField: false,
              hasPasswordField: true,
              hasOtpField: false,
              bodySignals: {},
              controls: [],
            };
      }
      if (script.includes("suppliedUsername")) {
        return {
          url: "https://id.churchofjesuschrist.org/oauth2/default/v1/authorize",
          usernameFieldFound: false,
          passwordFieldFound: true,
          filledUsername: false,
          filledPassword: true,
          clicked: true,
          submittedViaForm: false,
        };
      }
      return { clicked: false, reason: "No visible sign-in control found" };
    });

    const tool = createGospelLibraryTools()[0];
    if (!tool) throw new Error("Missing gospel_library tool");

    const result = await tool.handler({
      action: "login",
      url: "/study/scriptures/bofm/2-ne/3?lang=eng",
    });

    expect(manager.open).toHaveBeenCalledWith(
      "https://www.churchofjesuschrist.org/study/login?redirect_uri=%2Fstudy%2Fscriptures%2Fbofm%2F2-ne%2F3%3Flang%3Deng",
    );
    expect(result).toMatchObject({
      authenticated: true,
      needsLogin: false,
      credentialSource: "onepassword",
      credentialReady: true,
    });
  });

  it("returns a setup blocker when the Church 1Password item is not configured", async () => {
    delete process.env.CHURCH_ACCOUNT_1PASSWORD_VAULT;
    delete process.env.CHURCH_ACCOUNT_1PASSWORD_ITEM;
    manager.status.mockResolvedValue({
      connected: true,
      url: "https://www.churchofjesuschrist.org/study/scriptures?lang=eng",
    });
    manager.evaluate.mockImplementation(async (script: string) => {
      if (script.includes("fetch(")) {
        return {
          ok: false,
          status: 401,
          url: "https://www.churchofjesuschrist.org/notes/api/v3/annotations?type=reference&locale=eng&docId=128394547",
          body: "Sign in required",
        };
      }
      if (script.includes("hasPasswordField")) {
        return {
          hasUsernameField: false,
          hasPasswordField: false,
          hasOtpField: false,
          bodySignals: {},
        };
      }
      return { clicked: true, text: "Sign In" };
    });

    const tool = createGospelLibraryTools()[0];
    if (!tool) throw new Error("Missing gospel_library tool");

    const result = await tool.handler({ action: "login" });

    expect(getSecretMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      authenticated: false,
      needsLogin: true,
      credentialSource: "onepassword",
      credentialReady: false,
      credentialConfigured: false,
      missingConfig: [
        "CHURCH_ACCOUNT_1PASSWORD_VAULT",
        "CHURCH_ACCOUNT_1PASSWORD_ITEM",
      ],
    });
    expect(String((result as { message?: unknown }).message)).toContain("Do not ask Devin for the password in chat");
  });

  it("stops for user approval when Church login reaches second factor without TOTP", async () => {
    manager.status.mockResolvedValue({
      connected: true,
      url: "https://www.churchofjesuschrist.org/study/scriptures?lang=eng",
    });
    manager.wait.mockResolvedValue("Waited.");
    manager.evaluate.mockImplementation(async (script: string) => {
      if (script.includes("fetch(")) {
        return {
          ok: false,
          status: 401,
          url: "https://www.churchofjesuschrist.org/notes/api/v3/annotations?type=reference&locale=eng&docId=128394547",
          body: "Sign in required",
        };
      }
      if (script.includes("suppliedUsername")) {
        return {
          usernameFieldFound: true,
          passwordFieldFound: true,
          filledUsername: true,
          filledPassword: true,
          clicked: true,
          submittedViaForm: false,
        };
      }
      if (script.includes("hasPasswordField")) {
        return {
          url: "https://id.churchofjesuschrist.org/login",
          hasUsernameField: false,
          hasPasswordField: false,
          hasOtpField: true,
          bodySignals: { twoFactorText: true },
        };
      }
      return { clicked: true, text: "Sign In" };
    });

    const tool = createGospelLibraryTools()[0];
    if (!tool) throw new Error("Missing gospel_library tool");

    const result = await tool.handler({ action: "login" });

    expect(getOneTimePasswordMock).toHaveBeenCalledWith("ChurchVault", "ChurchItem");
    expect(result).toMatchObject({
      authenticated: false,
      needsLogin: true,
      needsSecondFactor: true,
      credentialSource: "onepassword",
      credentialReady: true,
    });
    expect(JSON.stringify(result)).not.toContain("correct horse battery staple");
  });

  it("keeps only annotation create/delete actions classified as mutating", () => {
    expect(gospelLibraryActionLooksMutating("status")).toBe(false);
    expect(gospelLibraryActionLooksMutating("open")).toBe(false);
    expect(gospelLibraryActionLooksMutating("prepare_login")).toBe(false);
    expect(gospelLibraryActionLooksMutating("login")).toBe(false);
    expect(gospelLibraryActionLooksMutating("list_annotations")).toBe(false);
    expect(gospelLibraryActionLooksMutating("create_reference_link")).toBe(true);
    expect(gospelLibraryActionLooksMutating("delete_annotation")).toBe(true);
  });
});
