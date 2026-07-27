/**
 * Church Session — one authenticated churchofjesuschrist.org session, kept alive.
 *
 * Everything the Church runs (Gospel Library study/notes, Leader and Clerk
 * Resources) sits behind a single Okta session at id.churchofjesuschrist.org.
 * Each app then mints its own short-lived OIDC token from that session. The
 * observed shape of that on a working profile:
 *
 *   id.churchofjesuschrist.org  idx              SESSION cookie  <- the SSO session
 *   id.churchofjesuschrist.org  DT, proximity_*  persistent      <- MFA device trust
 *   .churchofjesuschrist.org    oauth_id_token   1 hour, per app path
 *   .churchofjesuschrist.org    oauth_refresh_token  SESSION cookie
 *   lcr.churchofjesuschrist.org appSession.0/.1  SESSION cookies
 *
 * Every cookie that actually authenticates is browser-session scoped, so a
 * browser restart threw away a perfectly good login and forced a fresh
 * password round trip — the "we keep getting logged out" symptom. The pieces
 * that survive a restart (DT/proximity_) only remember the device for MFA.
 *
 * This module owns the whole lifecycle:
 *   - probe    cheap, unambiguous auth check per scope
 *   - silent   re-mint an expired app token from a live SSO session, no password
 *   - login    deterministic two-step Church sign-in from 1Password
 *   - persist  rewrite session-scoped auth cookies with a real expiry, so the
 *              session survives a browser restart (Brave keeps them in its own
 *              encrypted cookie store; nothing is written to disk by Tango)
 *
 * Callers use ensureChurchSession() before any authenticated Church work and
 * churchFetch() to make the call itself, which keeps Church traffic on a tab
 * pinned to the Church origin instead of whatever page another workflow left
 * the shared browser tab on.
 */

import type { BrowserContext, Page } from "playwright-core";
import { getBrowserManager, describeBrowserProfile } from "./browser-manager.js";
import { getOneTimePassword, getSecret, isOpAvailable } from "./op-secret.js";

const debug = (...args: unknown[]) => {
  console.error("[church-session]", ...args);
};

export const CHURCH_ORIGIN = "https://www.churchofjesuschrist.org";
export const LCR_ORIGIN = "https://lcr.churchofjesuschrist.org";
export const ID_ORIGIN = "https://id.churchofjesuschrist.org";

const CHURCH_ACCOUNT_VAULT_ENV = "CHURCH_ACCOUNT_1PASSWORD_VAULT";
const CHURCH_ACCOUNT_ITEM_ENV = "CHURCH_ACCOUNT_1PASSWORD_ITEM";

/** Authenticated GET that returns 200 signed in and 401 signed out. */
const STUDY_PROBE_URL =
  `${CHURCH_ORIGIN}/notes/api/v3/annotations?type=reference&locale=eng&docId=128394547`;

export const SCOPE_ANCHOR: Record<ChurchScope, string> = {
  study: `${CHURCH_ORIGIN}/study/scriptures?lang=eng`,
  lcr: `${LCR_ORIGIN}/mlt/records/member-list?lang=eng`,
};

const SCOPE_ORIGIN: Record<ChurchScope, string> = {
  study: CHURCH_ORIGIN,
  lcr: LCR_ORIGIN,
};

export type ChurchScope = "study" | "lcr";

export type ChurchAuthProbe = {
  scope: ChurchScope;
  authenticated: boolean;
  needsLogin: boolean;
  inconclusive: boolean;
  detail: string;
  status?: number | null;
  url?: string | null;
};

export type ChurchSessionResult = {
  scope: ChurchScope;
  authenticated: boolean;
  needsLogin: boolean;
  needsSecondFactor?: boolean;
  path: "already-authenticated" | "silent-sso" | "credential-login" | "failed";
  steps: Array<Record<string, unknown>>;
  probe: ChurchAuthProbe;
  persisted?: ChurchPersistResult | null;
  profile?: ReturnType<typeof describeBrowserProfile>;
  message: string;
};

export type ChurchPersistResult = {
  converted: string[];
  alreadyPersistent: number;
  expiresAt: string | null;
  error?: string;
};

/* -------------------------------------------------------------------------- */
/* Pure helpers (unit tested)                                                  */
/* -------------------------------------------------------------------------- */

/** True for any host under churchofjesuschrist.org. */
export function isChurchUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "churchofjesuschrist.org" || host.endsWith(".churchofjesuschrist.org");
  } catch {
    return false;
  }
}

/** Which session scope a Church URL belongs to (null when it is not a Church URL). */
export function churchScopeForUrl(url: string): ChurchScope | null {
  if (!isChurchUrl(url)) {
    return null;
  }
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "lcr.churchofjesuschrist.org") {
      return "lcr";
    }
    // id.* is the sign-in host itself; treat it as study so a caller landing
    // there gets the credential flow rather than an LCR page navigation.
    return "study";
  } catch {
    return null;
  }
}

/**
 * Cookies worth converting from session-scoped to persistent.
 *
 * Deliberately an allowlist of the cookies that carry the session: the Okta SSO
 * session and each app's own session/refresh token. Analytics cookies that also
 * happen to be session-scoped (Dynatrace dtCookie/dtSa/dtPC, Adobe s_*) are left
 * alone — matching them is how a loose pattern turns telemetry into stored state.
 */
export function shouldPersistChurchCookie(name: string): boolean {
  const exact = new Set([
    "idx", // Okta Identity Engine SSO session
    "sid", // Okta classic session (older orgs / fallback)
    "JSESSIONID", // id.churchofjesuschrist.org
    "oauth_refresh_token", // study/notes/content OIDC refresh
    "mltpSession", // member list tool API
  ]);
  if (exact.has(name)) {
    return true;
  }
  // LCR splits its session across appSession.0, appSession.1, ...
  return /^appSession(\.\d+)?$/u.test(name);
}

export type PersistableCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
};

/**
 * Pick the session-scoped auth cookies to rewrite with a real expiry.
 * `expires === -1` is Playwright's marker for "dies with the browser".
 */
export function planChurchCookiePersistence(
  cookies: PersistableCookie[],
  expiresAtSeconds: number,
): PersistableCookie[] {
  return cookies
    .filter(
      (cookie) =>
        cookie.domain.includes("churchofjesuschrist.org") &&
        cookie.expires === -1 &&
        shouldPersistChurchCookie(cookie.name),
    )
    .map((cookie) => ({ ...cookie, expires: expiresAtSeconds }));
}

/** Interpret the study-scope probe response. */
export function classifyStudyProbe(status: number, finalUrl: string): ChurchAuthProbe {
  const redirectedToSignIn = /id\.churchofjesuschrist\.org/i.test(finalUrl);
  if (status === 200 && !redirectedToSignIn) {
    return {
      scope: "study",
      authenticated: true,
      needsLogin: false,
      inconclusive: false,
      detail: "notes API returned 200",
      status,
      url: finalUrl,
    };
  }
  if (status === 401 || status === 403 || redirectedToSignIn) {
    return {
      scope: "study",
      authenticated: false,
      needsLogin: true,
      inconclusive: false,
      detail: redirectedToSignIn ? "notes API redirected to sign-in" : `notes API returned ${status}`,
      status,
      url: finalUrl,
    };
  }
  return {
    scope: "study",
    authenticated: false,
    needsLogin: false,
    inconclusive: true,
    detail: `notes API returned an unexpected status ${status}`,
    status,
    url: finalUrl,
  };
}

/** Interpret where an LCR navigation landed. LCR bounces signed-out users to the IdP. */
export function classifyLcrLanding(finalUrl: string, bodyText: string): ChurchAuthProbe {
  const text = bodyText.replace(/\s+/gu, " ").trim();
  if (/id\.churchofjesuschrist\.org/i.test(finalUrl)) {
    return {
      scope: "lcr",
      authenticated: false,
      needsLogin: true,
      inconclusive: false,
      detail: "LCR redirected to the Church sign-in page",
      url: finalUrl,
    };
  }
  if (!/lcr\.churchofjesuschrist\.org/i.test(finalUrl)) {
    return {
      scope: "lcr",
      authenticated: false,
      needsLogin: false,
      inconclusive: true,
      detail: `LCR navigation ended somewhere unexpected: ${finalUrl}`,
      url: finalUrl,
    };
  }
  if (/^\s*(not found|error)\s*$/iu.test(text)) {
    return {
      scope: "lcr",
      authenticated: false,
      needsLogin: false,
      inconclusive: true,
      detail: "LCR returned an error page — the route may have moved",
      url: finalUrl,
    };
  }
  // The signed-in LCR shell always renders its leader navigation.
  const signedInMarkers = /membership|callings|ministering|finance|reports|directory/iu.test(text);
  if (signedInMarkers) {
    return {
      scope: "lcr",
      authenticated: true,
      needsLogin: false,
      inconclusive: false,
      detail: "LCR rendered the signed-in leader shell",
      url: finalUrl,
    };
  }
  return {
    scope: "lcr",
    authenticated: false,
    needsLogin: false,
    inconclusive: true,
    detail: "LCR page loaded but no signed-in markers were found",
    url: finalUrl,
  };
}

/** Recognize an MFA challenge from the sign-in page's own words. */
export function looksLikeSecondFactor(bodyText: string, hasNonCredentialInput: boolean): boolean {
  const text = bodyText.replace(/\s+/gu, " ");
  const prompts =
    /verification code|enter the code|one[-\s]?time|security code|authenticator|passcode|approve this sign|push notification|verify your identity|send a code/iu;
  return hasNonCredentialInput || prompts.test(text);
}

/* -------------------------------------------------------------------------- */
/* Credentials                                                                 */
/* -------------------------------------------------------------------------- */

function envValue(name: string): string | null {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function churchCredentialRef(): { vault: string | null; item: string | null; missing: string[] } {
  const vault = envValue(CHURCH_ACCOUNT_VAULT_ENV) ?? envValue("CHURCH_1PASSWORD_VAULT");
  const item = envValue(CHURCH_ACCOUNT_ITEM_ENV) ?? envValue("CHURCH_1PASSWORD_ITEM");
  return {
    vault,
    item,
    missing: [
      ...(vault ? [] : [CHURCH_ACCOUNT_VAULT_ENV]),
      ...(item ? [] : [CHURCH_ACCOUNT_ITEM_ENV]),
    ],
  };
}

type CredentialLoad =
  | { ok: true; username: string; password: string; vault: string; item: string }
  | { ok: false; error: string; missingConfig?: string[]; missingFields?: string[]; opAvailable: boolean };

async function loadChurchCredentials(): Promise<CredentialLoad> {
  const ref = churchCredentialRef();
  if (!ref.vault || !ref.item) {
    return {
      ok: false,
      error: `Church account 1Password item is not configured (${ref.missing.join(", ")}).`,
      missingConfig: ref.missing,
      opAvailable: isOpAvailable(),
    };
  }
  if (!isOpAvailable()) {
    return {
      ok: false,
      error: "The 1Password service account is not available to this process, so the Church password cannot be read.",
      opAvailable: false,
    };
  }

  const [username, password] = await Promise.all([
    getSecret(ref.vault, ref.item, "username"),
    getSecret(ref.vault, ref.item, "password"),
  ]);
  if (!username || !password) {
    return {
      ok: false,
      error: "Church account 1Password item is missing username or password.",
      missingFields: [...(username ? [] : ["username"]), ...(password ? [] : ["password"])],
      opAvailable: true,
    };
  }
  return { ok: true, username, password, vault: ref.vault, item: ref.item };
}

/* -------------------------------------------------------------------------- */
/* Browser plumbing                                                            */
/* -------------------------------------------------------------------------- */

async function churchPage(scope: ChurchScope): Promise<Page> {
  const manager = getBrowserManager();
  await manager.ensureConnected(9223);
  return manager.pageForOrigin(SCOPE_ORIGIN[scope], SCOPE_ANCHOR[scope]);
}

async function churchContext(): Promise<BrowserContext> {
  const manager = getBrowserManager();
  await manager.ensureConnected(9223);
  return manager.context();
}

export type ChurchFetchResult = {
  ok: boolean;
  status: number | null;
  statusText: string | null;
  url: string | null;
  body: unknown;
  error?: string;
};

/**
 * Run an authenticated Church API call from a tab pinned to the Church origin,
 * so cookies are actually sent and a sibling workflow cannot move the page out
 * from under it.
 */
export async function churchFetch(
  scope: ChurchScope,
  input: { url: string; method?: string; body?: unknown },
): Promise<ChurchFetchResult> {
  const page = await churchPage(scope);
  const origin = SCOPE_ORIGIN[scope];
  // A tab that drifted off-origin (sign-in redirect, stray navigation) cannot
  // make credentialed same-origin calls — put it back before fetching.
  let currentOrigin = "";
  try {
    currentOrigin = new URL(page.url()).origin;
  } catch {
    currentOrigin = "";
  }
  if (currentOrigin !== origin) {
    await page
      .goto(SCOPE_ANCHOR[scope], { waitUntil: "domcontentloaded", timeout: 45_000 })
      .catch((err) => debug("re-anchor navigation failed", err));
  }

  return page.evaluate(
    async ({ url, method, body }) => {
      try {
        const response = await fetch(url, {
          method: method ?? "GET",
          credentials: "include",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        let parsed: unknown = null;
        if (text.length > 0) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
        }
        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          url: response.url,
          body: parsed,
        };
      } catch (err) {
        return {
          ok: false,
          status: null,
          statusText: null,
          url: null,
          body: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    { url: input.url, method: input.method ?? "GET", body: input.body },
  ) as Promise<ChurchFetchResult>;
}

/* -------------------------------------------------------------------------- */
/* Probes                                                                      */
/* -------------------------------------------------------------------------- */

export async function probeChurchAuth(scope: ChurchScope): Promise<ChurchAuthProbe> {
  if (scope === "study") {
    const result = await churchFetch("study", { url: STUDY_PROBE_URL });
    if (result.status === null) {
      return {
        scope,
        authenticated: false,
        needsLogin: false,
        inconclusive: true,
        detail: `notes API probe could not run: ${result.error ?? "unknown error"}`,
        status: null,
        url: null,
      };
    }
    return classifyStudyProbe(result.status, result.url ?? STUDY_PROBE_URL);
  }

  // LCR is server-rendered and bounces signed-out users through the IdP, so the
  // landing URL plus the rendered shell is the unambiguous signal.
  const page = await churchPage("lcr");
  await page
    .goto(SCOPE_ANCHOR.lcr, { waitUntil: "domcontentloaded", timeout: 60_000 })
    .catch((err) => debug("LCR probe navigation issue", err));
  await page.waitForTimeout(2_500);
  const bodyText = await page
    .evaluate(() => (document.body?.innerText ?? "").slice(0, 4000))
    .catch(() => "");
  return classifyLcrLanding(page.url(), bodyText);
}

/* -------------------------------------------------------------------------- */
/* Cookie persistence                                                          */
/* -------------------------------------------------------------------------- */

const PERSIST_TTL_DAYS = 30;

/**
 * Give the session-scoped Church auth cookies a real expiry so the login is not
 * discarded the next time Brave restarts. This does not extend the server-side
 * session — it stops us from throwing away one that is still valid.
 *
 * Runs more than one pass on purpose. A Church page that is still settling can
 * re-issue its session cookie (Okta rotates `idx`) a second or two after we
 * harden it, which silently puts the session back to "dies with the browser".
 * Each pass re-reads the jar and converts whatever came back session-scoped,
 * stopping as soon as a pass finds nothing left to do.
 */
export async function persistChurchSessionCookies(
  options: { ttlDays?: number; passes?: number; retryDelayMs?: number } = {},
): Promise<ChurchPersistResult> {
  const ttlDays = options.ttlDays ?? PERSIST_TTL_DAYS;
  const passes = options.passes ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 1_500;
  try {
    const ctx = await churchContext();
    const converted = new Set<string>();
    let expiresAtSeconds = 0;
    let alreadyPersistent = 0;

    for (let pass = 0; pass < passes; pass += 1) {
      if (pass > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
      const cookies = (await ctx.cookies()) as PersistableCookie[];
      const churchCookies = cookies.filter((c) => c.domain.includes("churchofjesuschrist.org"));
      alreadyPersistent = churchCookies.filter(
        (c) => c.expires !== -1 && shouldPersistChurchCookie(c.name),
      ).length;

      expiresAtSeconds = Math.floor(Date.now() / 1000) + ttlDays * 24 * 3600;
      const plan = planChurchCookiePersistence(churchCookies, expiresAtSeconds);
      if (plan.length === 0) {
        break;
      }

      await ctx.addCookies(
        plan.map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          expires: cookie.expires,
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
          sameSite: cookie.sameSite,
        })),
      );
      for (const cookie of plan) {
        converted.add(`${cookie.domain}${cookie.path}:${cookie.name}`);
      }
    }

    return {
      converted: [...converted],
      alreadyPersistent,
      expiresAt: converted.size > 0 ? new Date(expiresAtSeconds * 1000).toISOString() : null,
    };
  } catch (err) {
    return {
      converted: [],
      alreadyPersistent: 0,
      expiresAt: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Sign-in                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Re-mint an app token from a live SSO session. The study app's /study/login
 * endpoint runs the OIDC round trip; with a valid Okta session it completes
 * without any user interaction, which is the correct fix for the common case of
 * an expired one-hour app token.
 */
async function attemptSilentSso(scope: ChurchScope, targetPath?: string): Promise<Record<string, unknown>> {
  const page = await churchPage(scope);
  const redirect = targetPath && targetPath.startsWith("/") ? targetPath : "/study/scriptures?lang=eng";
  const url =
    scope === "study"
      ? `${CHURCH_ORIGIN}/study/login?redirect_uri=${encodeURIComponent(redirect)}`
      : SCOPE_ANCHOR.lcr;

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((err) => {
    debug("silent SSO navigation issue", err);
  });
  await page.waitForTimeout(2_500);
  return { step: "silent-sso", url, landedOn: page.url() };
}

type LoginOutcome = {
  ok: boolean;
  needsSecondFactor: boolean;
  steps: Array<Record<string, unknown>>;
  message: string;
};

/**
 * Deterministic Church sign-in. The Church IdP ("Eden" widget on Okta) is a
 * two-step flow with stable ids: #username-input then #password-input, each
 * submitted by #button-primary. Selector fallbacks cover a widget revision;
 * the page also has ~100 language buttons, which is why generic
 * "click the button that says Next" scraping is unreliable here.
 */
async function performCredentialLogin(
  credentials: { username: string; password: string; vault: string; item: string },
  targetPath?: string,
): Promise<LoginOutcome> {
  const steps: Array<Record<string, unknown>> = [];
  const page = await churchPage("study");
  const redirect = targetPath && targetPath.startsWith("/") ? targetPath : "/study/scriptures?lang=eng";

  await page
    .goto(`${CHURCH_ORIGIN}/study/login?redirect_uri=${encodeURIComponent(redirect)}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })
    .catch((err) => debug("login navigation issue", err));
  await page.waitForTimeout(1_500);
  steps.push({ step: "open-login", landedOn: page.url() });

  // Already signed in? The IdP sends us straight back to the app.
  if (!page.url().startsWith(ID_ORIGIN)) {
    steps.push({ step: "no-sign-in-required", landedOn: page.url() });
    return { ok: true, needsSecondFactor: false, steps, message: "Session restored without entering credentials." };
  }

  const usernameField = page
    .locator("#username-input, input[autocomplete='username'], input[name='username']")
    .first();
  const appeared = await usernameField
    .waitFor({ state: "visible", timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    steps.push({ step: "username-field", found: false, landedOn: page.url() });
    return {
      ok: false,
      needsSecondFactor: false,
      steps,
      message: "The Church sign-in page did not present a username field.",
    };
  }

  await usernameField.fill(credentials.username);
  const submit = page.locator("#button-primary, button[type='submit']").first();
  if ((await submit.count().catch(() => 0)) > 0) {
    await submit.click({ timeout: 10_000 }).catch(() => usernameField.press("Enter"));
  } else {
    await usernameField.press("Enter");
  }
  steps.push({ step: "submit-username", ok: true });

  const passwordField = page
    .locator("#password-input, input[type='password'], input[autocomplete='current-password']")
    .first();
  const passwordReady = await passwordField
    .waitFor({ state: "visible", timeout: 25_000 })
    .then(() => true)
    .catch(() => false);
  if (!passwordReady) {
    const body = await page.evaluate(() => (document.body?.innerText ?? "").slice(0, 1500)).catch(() => "");
    steps.push({ step: "password-field", found: false, landedOn: page.url() });
    if (looksLikeSecondFactor(body, false)) {
      return {
        ok: false,
        needsSecondFactor: true,
        steps,
        message: "The Church sign-in asked for a second factor before the password step.",
      };
    }
    return {
      ok: false,
      needsSecondFactor: false,
      steps,
      message: "The Church sign-in page never presented a password field after the username step.",
    };
  }

  await passwordField.fill(credentials.password);
  const verify = page.locator("#button-primary, button[type='submit']").first();
  if ((await verify.count().catch(() => 0)) > 0) {
    await verify.click({ timeout: 10_000 }).catch(() => passwordField.press("Enter"));
  } else {
    await passwordField.press("Enter");
  }
  steps.push({ step: "submit-password", ok: true });

  await page.waitForTimeout(4_000);

  // Second factor, if the device is not trusted.
  if (page.url().startsWith(ID_ORIGIN)) {
    const state = await page
      .evaluate(() => {
        const body = (document.body?.innerText ?? "").slice(0, 1500);
        const extra = [...document.querySelectorAll("input")].some((input) => {
          const el = input as HTMLInputElement;
          const visible = !!(el.offsetWidth || el.offsetHeight);
          return visible && el.type !== "password" && el.type !== "hidden" && el.id !== "username-input";
        });
        return { body, extra };
      })
      .catch(() => ({ body: "", extra: false }));

    if (looksLikeSecondFactor(state.body, state.extra)) {
      const otp = await getOneTimePassword(credentials.vault, credentials.item);
      if (!otp) {
        steps.push({ step: "second-factor", totpAvailable: false, prompt: state.body.slice(0, 200) });
        return {
          ok: false,
          needsSecondFactor: true,
          steps,
          message:
            "The Church sign-in asked for a second factor. This account signs in with username and password only, " +
            "so this means the Church added a verification step (or flagged this device). The account owner needs to " +
            "complete it once in the automation browser; if an authenticator is enrolled at that point, adding its " +
            "secret to the 1Password item makes this self-healing again.",
        };
      }
      const codeField = page
        .locator("input[autocomplete='one-time-code'], #code-input, input[inputmode='numeric'], input[name*='code' i]")
        .first();
      if ((await codeField.count().catch(() => 0)) > 0) {
        await codeField.fill(otp);
        const verifyOtp = page.locator("#button-primary, button[type='submit']").first();
        if ((await verifyOtp.count().catch(() => 0)) > 0) {
          await verifyOtp.click({ timeout: 10_000 }).catch(() => codeField.press("Enter"));
        } else {
          await codeField.press("Enter");
        }
        steps.push({ step: "second-factor", totpAvailable: true, submitted: true });
        await page.waitForTimeout(4_000);
      } else {
        steps.push({ step: "second-factor", totpAvailable: true, submitted: false });
        return {
          ok: false,
          needsSecondFactor: true,
          steps,
          message: "A second factor was requested but no code field was found on the page.",
        };
      }
    }
  }

  return { ok: true, needsSecondFactor: false, steps, message: "Submitted Church credentials." };
}

/** Poll the probe until the session comes up (sign-in redirects settle async). */
async function waitForAuthenticated(scope: ChurchScope, timeoutMs = 20_000): Promise<ChurchAuthProbe> {
  const deadline = Date.now() + timeoutMs;
  let probe = await probeChurchAuth(scope);
  while (!probe.authenticated && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    probe = await probeChurchAuth(scope);
  }
  return probe;
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                          */
/* -------------------------------------------------------------------------- */

// One sign-in at a time. Two tools racing into the credential flow log each
// other out mid-redirect, which reads as a flaky password.
const inFlight = new Map<ChurchScope, Promise<ChurchSessionResult>>();

export async function ensureChurchSession(
  options: { scope?: ChurchScope; url?: string; allowLogin?: boolean } = {},
): Promise<ChurchSessionResult> {
  const scope = options.scope ?? (options.url ? churchScopeForUrl(options.url) ?? "study" : "study");
  const existing = inFlight.get(scope);
  if (existing) {
    return existing;
  }
  const run = ensureChurchSessionInner(scope, options).finally(() => inFlight.delete(scope));
  inFlight.set(scope, run);
  return run;
}

async function ensureChurchSessionInner(
  scope: ChurchScope,
  options: { url?: string; allowLogin?: boolean },
): Promise<ChurchSessionResult> {
  const steps: Array<Record<string, unknown>> = [];
  const profile = describeBrowserProfile(9223);
  if (profile.matches === false) {
    steps.push({
      step: "profile-mismatch",
      expected: profile.expected,
      actual: profile.actual,
      note: "The connected browser is running a different profile than this process resolves, so its saved Church login is a different cookie jar.",
    });
  }

  let targetPath: string | undefined;
  if (options.url) {
    try {
      const parsed = new URL(options.url, SCOPE_ANCHOR[scope]);
      targetPath = `${parsed.pathname}${parsed.search}`;
    } catch {
      targetPath = undefined;
    }
  }

  const first = await probeChurchAuth(scope);
  steps.push({ step: "probe", ...first });
  if (first.authenticated) {
    const persisted = await persistChurchSessionCookies();
    return {
      scope,
      authenticated: true,
      needsLogin: false,
      path: "already-authenticated",
      steps,
      probe: first,
      persisted,
      profile,
      message: `Church ${scope} session is authenticated.`,
    };
  }

  // Cheap path: a live SSO session can re-mint the app token with no password.
  steps.push(await attemptSilentSso(scope, targetPath));
  const afterSilent = await probeChurchAuth(scope);
  steps.push({ step: "probe-after-silent-sso", ...afterSilent });
  if (afterSilent.authenticated) {
    const persisted = await persistChurchSessionCookies();
    return {
      scope,
      authenticated: true,
      needsLogin: false,
      path: "silent-sso",
      steps,
      probe: afterSilent,
      persisted,
      profile,
      message: `Church ${scope} session was restored from the existing single sign-on session (no password needed).`,
    };
  }

  if (options.allowLogin === false) {
    return {
      scope,
      authenticated: false,
      needsLogin: true,
      path: "failed",
      steps,
      probe: afterSilent,
      profile,
      message: `Church ${scope} session is signed out and credential login was not permitted for this call.`,
    };
  }

  const credentials = await loadChurchCredentials();
  if (!credentials.ok) {
    steps.push({ step: "credentials", ok: false, error: credentials.error });
    return {
      scope,
      authenticated: false,
      needsLogin: true,
      path: "failed",
      steps,
      probe: afterSilent,
      profile,
      message: `${credentials.error} Do not ask for the password in chat — fix the 1Password item or service-account access.`,
    };
  }

  const login = await performCredentialLogin(credentials, targetPath);
  steps.push(...login.steps);

  const finalProbe = login.ok ? await waitForAuthenticated(scope) : await probeChurchAuth(scope);
  steps.push({ step: "probe-after-login", ...finalProbe });

  if (finalProbe.authenticated) {
    const persisted = await persistChurchSessionCookies();
    return {
      scope,
      authenticated: true,
      needsLogin: false,
      path: "credential-login",
      steps,
      probe: finalProbe,
      persisted,
      profile,
      message: `Signed in to the Church ${scope} session with the configured 1Password item.`,
    };
  }

  return {
    scope,
    authenticated: false,
    needsLogin: true,
    needsSecondFactor: login.needsSecondFactor,
    path: "failed",
    steps,
    probe: finalProbe,
    profile,
    message: login.needsSecondFactor
      ? login.message
      : `Church ${scope} sign-in did not complete: ${login.message} Inspect the browser for a captcha, an account notice, or an upstream Church error.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Diagnostics + keepalive                                                     */
/* -------------------------------------------------------------------------- */

export async function churchSessionDiagnostics(): Promise<Record<string, unknown>> {
  const profile = describeBrowserProfile(9223);
  let cookieReport: Array<Record<string, unknown>> = [];
  let cookieError: string | null = null;
  try {
    const ctx = await churchContext();
    const cookies = (await ctx.cookies()) as PersistableCookie[];
    cookieReport = cookies
      .filter((c) => c.domain.includes("churchofjesuschrist.org") && shouldPersistChurchCookie(c.name))
      .map((c) => ({
        cookie: `${c.domain}${c.path}:${c.name}`,
        persistent: c.expires !== -1,
        expiresAt: c.expires === -1 ? null : new Date(c.expires * 1000).toISOString(),
        survivesRestart: c.expires !== -1,
      }));
  } catch (err) {
    cookieError = err instanceof Error ? err.message : String(err);
  }

  const credentialRef = churchCredentialRef();
  return {
    browserProfile: profile,
    profileWarning:
      profile.matches === false
        ? "The running browser uses a different profile directory than this process resolves — saved Church logins live in the other cookie jar."
        : null,
    credentials: {
      configured: credentialRef.missing.length === 0,
      missingConfig: credentialRef.missing,
      opAvailable: isOpAvailable(),
    },
    sessionCookies: cookieReport,
    sessionCookieError: cookieError,
    sessionSurvivesRestart:
      cookieReport.length > 0 && cookieReport.every((entry) => entry.survivesRestart === true),
  };
}

/**
 * Keep the Church session warm. The Okta session idles out server-side, so a
 * periodic touch is what turns "persists across restarts" into "always signed
 * in"; it also re-persists cookies the Church rotated since the last run.
 */
export async function runChurchSessionKeepalive(): Promise<{
  study: ChurchSessionResult;
  lcr: ChurchSessionResult;
  persisted: ChurchPersistResult;
}> {
  const study = await ensureChurchSession({ scope: "study" });
  const lcr = await ensureChurchSession({ scope: "lcr" });
  const persisted = await persistChurchSessionCookies();
  return { study, lcr, persisted };
}
