import { beforeEach, describe, expect, it, vi } from "vitest";

const manager = {
  launch: vi.fn(),
  status: vi.fn(),
  open: vi.fn(),
  evaluate: vi.fn(),
  wait: vi.fn(),
  ensureConnected: vi.fn(),
  pageForOrigin: vi.fn(),
  context: vi.fn(),
};

const churchSession = vi.hoisted(() => ({
  ensureChurchSession: vi.fn(),
  churchFetch: vi.fn(),
  churchSessionDiagnostics: vi.fn(),
  persistChurchSessionCookies: vi.fn(),
}));

vi.mock("../src/browser-manager.js", () => ({
  getBrowserManager: () => manager,
  describeBrowserProfile: () => ({ expected: "/tmp/profile", actual: "/tmp/profile", matches: true }),
}));

vi.mock("../src/church-session.js", async (importOriginal) => {
  // Keep the real pure helpers (URL/scope classification) and stub the parts
  // that need a live browser.
  const actual = await importOriginal<typeof import("../src/church-session.js")>();
  return {
    ...actual,
    ensureChurchSession: churchSession.ensureChurchSession,
    churchFetch: churchSession.churchFetch,
    churchSessionDiagnostics: churchSession.churchSessionDiagnostics,
    persistChurchSessionCookies: churchSession.persistChurchSessionCookies,
  };
});

import {
  createGospelLibraryTools,
  gospelLibraryActionLooksMutating,
} from "../src/gospel-library-agent-tools.js";

const authenticated = (scope: "study" | "lcr" = "study") => ({
  scope,
  authenticated: true,
  needsLogin: false,
  path: "already-authenticated" as const,
  steps: [],
  probe: { scope, authenticated: true, needsLogin: false, inconclusive: false, detail: "notes API returned 200" },
  persisted: { converted: ["id.churchofjesuschrist.org/:idx"], alreadyPersistent: 3, expiresAt: "2026-08-25T00:00:00.000Z" },
  profile: { expected: "/tmp/profile", actual: "/tmp/profile", matches: true },
  message: `Church ${scope} session is authenticated.`,
});

const signedOut = (overrides: Record<string, unknown> = {}) => ({
  scope: "study" as const,
  authenticated: false,
  needsLogin: true,
  path: "failed" as const,
  steps: [],
  probe: { scope: "study", authenticated: false, needsLogin: true, inconclusive: false, detail: "notes API returned 401" },
  profile: { expected: "/tmp/profile", actual: "/tmp/profile", matches: true },
  message: "Church study sign-in did not complete.",
  ...overrides,
});

const tool = () => {
  const found = createGospelLibraryTools()[0];
  if (!found) throw new Error("Missing gospel_library tool");
  return found;
};

describe("gospel-library-agent-tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    churchSession.ensureChurchSession.mockResolvedValue(authenticated());
    churchSession.churchSessionDiagnostics.mockResolvedValue({ sessionSurvivesRestart: true });
    churchSession.churchFetch.mockResolvedValue({ ok: true, status: 200, statusText: "OK", url: "https://www.churchofjesuschrist.org/notes/api/v3/annotations", body: [] });
  });

  it("reports session state on status without triggering a sign-in", async () => {
    await tool().handler({ action: "status" });

    expect(churchSession.ensureChurchSession).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "study", allowLogin: false }),
    );
  });

  it("includes restart-survival diagnostics in status so a failure can be explained", async () => {
    churchSession.ensureChurchSession.mockResolvedValue(signedOut());
    churchSession.churchSessionDiagnostics.mockResolvedValue({
      sessionSurvivesRestart: false,
      browserProfile: { expected: "/a", actual: "/b", matches: false },
    });

    const result = await tool().handler({ action: "status" });

    expect(result).toMatchObject({
      authenticated: false,
      diagnostics: { sessionSurvivesRestart: false },
    });
  });

  it("routes ensure_session to the LCR scope for Leader and Clerk Resources work", async () => {
    churchSession.ensureChurchSession.mockResolvedValue(authenticated("lcr"));

    const result = await tool().handler({ action: "ensure_session", scope: "lcr" });

    expect(churchSession.ensureChurchSession).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "lcr" }),
    );
    expect(result).toMatchObject({ authenticated: true, scope: "lcr" });
  });

  it("infers the LCR scope from an LCR url", async () => {
    churchSession.ensureChurchSession.mockResolvedValue(authenticated("lcr"));

    await tool().handler({
      action: "ensure_session",
      url: "https://lcr.churchofjesuschrist.org/mlt/records/member-list?lang=eng",
    });

    expect(churchSession.ensureChurchSession).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "lcr" }),
    );
  });

  it("keeps login and prepare_login working as aliases of ensure_session", async () => {
    for (const action of ["login", "prepare_login"]) {
      churchSession.ensureChurchSession.mockClear();
      const result = await tool().handler({ action });
      expect(churchSession.ensureChurchSession).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ authenticated: true });
    }
  });

  it("heals the session before a read instead of returning a sign-in page as data", async () => {
    await tool().handler({ action: "list_annotations", query: { docId: "1" } });

    expect(churchSession.ensureChurchSession).toHaveBeenCalledWith({ scope: "study" });
    expect(churchSession.churchFetch).toHaveBeenCalledWith(
      "study",
      expect.objectContaining({ url: expect.stringContaining("/notes/api/v3/annotations?docId=1") }),
    );
  });

  it("refuses to write when the session could not be restored", async () => {
    churchSession.ensureChurchSession.mockResolvedValue(signedOut());

    const result = await tool().handler({
      action: "create_highlight",
      uri: "/scriptures/bofm/2-ne/23",
      verse: 6,
      phrase: "day of the Lord",
    });

    expect(churchSession.churchFetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      error: expect.stringContaining("not authenticated"),
      needsLogin: true,
    });
  });

  it("surfaces a second-factor block without leaking the password", async () => {
    churchSession.ensureChurchSession.mockResolvedValue(
      signedOut({
        needsSecondFactor: true,
        message: "The Church sign-in asked for a second factor and the 1Password item has no one-time password field.",
      }),
    );

    const result = await tool().handler({ action: "login" });

    expect(result).toMatchObject({ authenticated: false, needsSecondFactor: true });
    expect(JSON.stringify(result)).not.toMatch(/password['"]?\s*:\s*['"][^'"]/i);
  });

  it("keeps only annotation create/delete actions classified as mutating", () => {
    expect(gospelLibraryActionLooksMutating("status")).toBe(false);
    expect(gospelLibraryActionLooksMutating("open")).toBe(false);
    expect(gospelLibraryActionLooksMutating("ensure_session")).toBe(false);
    expect(gospelLibraryActionLooksMutating("prepare_login")).toBe(false);
    expect(gospelLibraryActionLooksMutating("login")).toBe(false);
    expect(gospelLibraryActionLooksMutating("list_annotations")).toBe(false);
    expect(gospelLibraryActionLooksMutating("create_reference_link")).toBe(true);
    expect(gospelLibraryActionLooksMutating("delete_annotation")).toBe(true);
  });
});
