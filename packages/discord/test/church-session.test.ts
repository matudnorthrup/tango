import { describe, expect, it } from "vitest";
import {
  churchScopeForUrl,
  classifyLcrLanding,
  classifyStudyProbe,
  isChurchUrl,
  looksLikeSecondFactor,
  planChurchCookiePersistence,
  shouldPersistChurchCookie,
  type PersistableCookie,
} from "../src/church-session.js";

const cookie = (overrides: Partial<PersistableCookie>): PersistableCookie => ({
  name: "idx",
  value: "token",
  domain: "id.churchofjesuschrist.org",
  path: "/",
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: "None",
  ...overrides,
});

describe("church URL classification", () => {
  it("recognizes Church hosts without matching lookalike domains", () => {
    expect(isChurchUrl("https://www.churchofjesuschrist.org/study/scriptures")).toBe(true);
    expect(isChurchUrl("https://lcr.churchofjesuschrist.org/mlt/records/member-list")).toBe(true);
    expect(isChurchUrl("https://churchofjesuschrist.org/")).toBe(true);
    expect(isChurchUrl("https://notchurchofjesuschrist.org/")).toBe(false);
    expect(isChurchUrl("https://churchofjesuschrist.org.evil.test/")).toBe(false);
    expect(isChurchUrl("not a url")).toBe(false);
  });

  it("routes LCR to the lcr scope and everything else to study", () => {
    expect(churchScopeForUrl("https://lcr.churchofjesuschrist.org/orgs")).toBe("lcr");
    expect(churchScopeForUrl("https://www.churchofjesuschrist.org/study/scriptures")).toBe("study");
    expect(churchScopeForUrl("https://id.churchofjesuschrist.org/oauth2/default/v1/authorize")).toBe("study");
    expect(churchScopeForUrl("https://example.test")).toBeNull();
  });
});

describe("cookie persistence planning", () => {
  it("persists only the cookies that carry the session", () => {
    expect(shouldPersistChurchCookie("idx")).toBe(true);
    expect(shouldPersistChurchCookie("oauth_refresh_token")).toBe(true);
    expect(shouldPersistChurchCookie("appSession.0")).toBe(true);
    expect(shouldPersistChurchCookie("appSession")).toBe(true);
    expect(shouldPersistChurchCookie("JSESSIONID")).toBe(true);
  });

  it("leaves analytics and telemetry cookies alone", () => {
    // Dynatrace and Adobe cookies are session-scoped too; a loose pattern such as
    // /dt/i or /session/i would quietly turn telemetry into stored state.
    for (const name of ["dtCookie", "dtSa", "dtPC", "s_cc", "s_sq", "TAsessionID", "QSI_HistorySession"]) {
      expect(shouldPersistChurchCookie(name)).toBe(false);
    }
  });

  it("rewrites only session-scoped Church auth cookies with the new expiry", () => {
    const expiresAt = 1_800_000_000;
    const plan = planChurchCookiePersistence(
      [
        cookie({ name: "idx" }),
        cookie({ name: "oauth_refresh_token", domain: ".churchofjesuschrist.org", path: "/study" }),
        cookie({ name: "dtCookie", domain: ".churchofjesuschrist.org" }),
        cookie({ name: "DT", expires: 1_795_000_000 }),
        cookie({ name: "idx", domain: "id.example.test" }),
      ],
      expiresAt,
    );

    expect(plan.map((entry) => `${entry.domain}${entry.path}:${entry.name}`)).toEqual([
      "id.churchofjesuschrist.org/:idx",
      ".churchofjesuschrist.org/study:oauth_refresh_token",
    ]);
    expect(plan.every((entry) => entry.expires === expiresAt)).toBe(true);
  });

  it("preserves cookie attributes so httpOnly session cookies stay httpOnly", () => {
    const [persisted] = planChurchCookiePersistence([cookie({})], 1_800_000_000);
    expect(persisted).toMatchObject({ httpOnly: true, secure: true, sameSite: "None", path: "/" });
  });
});

describe("study auth probe", () => {
  it("treats a 200 from the notes API as authenticated", () => {
    const probe = classifyStudyProbe(200, "https://www.churchofjesuschrist.org/notes/api/v3/annotations");
    expect(probe).toMatchObject({ authenticated: true, needsLogin: false, inconclusive: false });
  });

  it("treats 401/403 as signed out rather than inconclusive", () => {
    for (const status of [401, 403]) {
      const probe = classifyStudyProbe(status, "https://www.churchofjesuschrist.org/notes/api/v3/annotations");
      expect(probe).toMatchObject({ authenticated: false, needsLogin: true, inconclusive: false });
    }
  });

  it("treats a redirect to the identity provider as signed out even on a 200", () => {
    const probe = classifyStudyProbe(200, "https://id.churchofjesuschrist.org/oauth2/default/v1/authorize");
    expect(probe).toMatchObject({ authenticated: false, needsLogin: true });
  });

  it("does not claim a sign-in is needed when the site is simply erroring", () => {
    const probe = classifyStudyProbe(503, "https://www.churchofjesuschrist.org/notes/api/v3/annotations");
    expect(probe).toMatchObject({ authenticated: false, needsLogin: false, inconclusive: true });
  });
});

describe("LCR auth probe", () => {
  it("detects the signed-in leader shell", () => {
    const probe = classifyLcrLanding(
      "https://lcr.churchofjesuschrist.org/mlt/records/member-list?lang=eng",
      "Membership Callings Ministering and Welfare Finance Reports Waldport Ward",
    );
    expect(probe).toMatchObject({ authenticated: true, needsLogin: false });
  });

  it("detects the sign-in bounce", () => {
    const probe = classifyLcrLanding(
      "https://id.churchofjesuschrist.org/oauth2/default/v1/authorize?client_id=abc",
      "Sign In Username Next",
    );
    expect(probe).toMatchObject({ authenticated: false, needsLogin: true, inconclusive: false });
  });

  it("flags a moved route as inconclusive instead of a login failure", () => {
    const probe = classifyLcrLanding("https://lcr.churchofjesuschrist.org/orgs/legacy-route", "Not Found");
    expect(probe).toMatchObject({ authenticated: false, needsLogin: false, inconclusive: true });
  });
});

describe("second factor detection", () => {
  it("recognizes the common challenge prompts", () => {
    for (const prompt of [
      "Enter the verification code we sent",
      "Get a push notification — approve this sign in",
      "Enter your one-time passcode from the authenticator app",
    ]) {
      expect(looksLikeSecondFactor(prompt, false)).toBe(true);
    }
  });

  it("recognizes a code field even when the copy is unfamiliar", () => {
    expect(looksLikeSecondFactor("Something new from the Church", true)).toBe(true);
  });

  it("does not fire on the ordinary password step", () => {
    expect(looksLikeSecondFactor("Sign In Password Verify Back Can't sign in?", false)).toBe(false);
  });
});
