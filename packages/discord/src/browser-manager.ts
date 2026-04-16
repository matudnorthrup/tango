/**
 * Browser Manager — Native Playwright-based browser automation for Tango.
 *
 * Connects to existing Chrome/Brave/Edge via Chrome DevTools Protocol (CDP).
 * Provides accessibility snapshots with numbered refs for AI agent interaction.
 *
 * The browser must be pre-launched with --remote-debugging-port=NNNN.
 * For sites with bot detection (e.g. Walmart/Arkose Labs), connecting to a
 * real Chrome/Brave instance avoids automated-browser fingerprint detection.
 */

import { chromium, type Browser, type Page } from "playwright-core";
import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveLegacyDataDir, resolveTangoDataPath } from "@tango/core";
import {
  buildEmailEvidenceHtml,
  buildRampReviewUrl,
  buildRampReviewVisualState,
  countRampReceiptSubmissionEvents,
  extractWalmartExplicitDates,
  extractWalmartOrderIdFromUrl,
  extractRampReimbursementIdFromUrl,
  flattenWalmartOrderId,
  formatRampTransactionDate,
  normalizeWalmartOrderId,
  parseGogEmailFullOutput,
  parseFlexibleDateToIso,
  rampPageLooksSignedOut,
  rampReimbursementLooksSubmitted,
  rampReviewVisualStateChanged,
  rampReviewVisualStateLooksReceiptLike,
  rampReviewBodyLooksAutoVerified,
  WALMART_PAYMENT_SUMMARY_SELECTORS,
} from "./reimbursement-automation.js";
import {
  archiveReimbursementEvidence,
  loadReimbursementEvidenceRecord,
} from "./reimbursement-evidence.js";
import type { RampReimbursementHistoryRecord } from "./receipt-reimbursement-registry.js";

const debug = (...args: unknown[]) => {
  console.error("[browser-manager]", ...args);
};

const CDP_CONNECT_TIMEOUT_MS = 15_000;
const PAGE_READY_TIMEOUT_MS = 10_000;

export interface WalmartHistoryCandidate {
  orderId: string;
  orderUrl: string;
  date: string;
  dateText: string;
  driverTip: number;
  total?: number;
  cardCharge?: string;
  itemsLine?: string;
  deliverySummary: string;
  notes: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function buildRampMerchantCandidates(merchant: string): string[] {
  const trimmed = merchant.trim();
  const candidates = new Set<string>();
  const push = (value: string) => {
    const normalized = value.trim();
    if (normalized.length > 0) {
      candidates.add(normalized);
    }
  };

  push(trimmed);
  push(trimmed.replace(/\([^)]*\)/gu, "").trim());

  const firstSegment = trimmed.split(/\s+-\s+|:\s+/u)[0] ?? trimmed;
  push(firstSegment);

  if (/^venmo\b/iu.test(trimmed)) {
    push("Venmo");
  }

  return [...candidates];
}

function normalizeRampHistoryCell(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/gu, " ").trim();
  if (!trimmed || trimmed === "—") {
    return undefined;
  }
  return trimmed;
}

function parseRampHistoryAmount(value: string | undefined): number | undefined {
  const normalized = normalizeRampHistoryCell(value)?.replace(/[^0-9.-]/gu, "");
  if (!normalized) {
    return undefined;
  }
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function evidencePathLooksImage(filePath: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/iu.test(filePath);
}

let manager: BrowserManager | null = null;

export function getBrowserManager(): BrowserManager {
  if (!manager) manager = new BrowserManager();
  return manager;
}

/** Find the Brave browser executable on macOS. */
function findBrowserPath(): string | null {
  const p = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
  return fs.existsSync(p) ? p : null;
}

export function resolveBrowserProfileDir(): string {
  const configured = process.env.TANGO_BROWSER_PROFILE_DIR?.trim();
  if (configured && configured.length > 0) {
    return path.resolve(configured);
  }

  if (process.env.TANGO_DATA_DIR?.trim()) {
    return resolveTangoDataPath("browser-profile");
  }

  const legacyProfileDir = path.join(resolveLegacyDataDir(), "browser-profile");
  if (fs.existsSync(legacyProfileDir)) {
    return legacyProfileDir;
  }

  return resolveTangoDataPath("browser-profile");
}

export function buildBrowserLaunchArgs(port: number, profileDir: string): string[] {
  return [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
}

/** Check if a browser is already listening on the given CDP port. */
async function isCdpPortOpen(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export class BrowserManager {
  private browser: Browser | null = null;
  private page: Page | null = null;

  /**
   * Launch Brave with remote debugging enabled.
   * If Brave is already listening on the port, connects to it instead.
   * Uses port 9223 by default to avoid conflicts with other browsers.
   */
  async launch(port = 9223): Promise<string> {
    // Already listening? Just connect.
    if (await isCdpPortOpen(port)) {
      debug(`CDP port ${port} already open, connecting`);
      return this.connect(`http://127.0.0.1:${port}`);
    }

    const browserPath = findBrowserPath();
    if (!browserPath) {
      throw new Error(
        "Brave not found. Install Brave Browser in /Applications.",
      );
    }

    const profileDir = resolveBrowserProfileDir();
    fs.mkdirSync(profileDir, { recursive: true });

    debug(`Launching Brave with --remote-debugging-port=${port} profile=${profileDir}`);

    const child = spawn(browserPath, buildBrowserLaunchArgs(port, profileDir), {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    // Wait for CDP to become available (up to 10s)
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await isCdpPortOpen(port)) {
        debug(`Brave ready on port ${port}`);
        return this.connect(`http://127.0.0.1:${port}`);
      }
    }

    throw new Error(
      `Brave launched but CDP port ${port} did not become available within 10s.`,
    );
  }

  /** Connect to an existing browser via Chrome DevTools Protocol. */
  async connect(cdpUrl: string): Promise<string> {
    if (this.browser && this.page) {
      try {
        const title = await withTimeout(
          this.page.title(),
          PAGE_READY_TIMEOUT_MS,
          "Browser page title",
        );
        const url = this.page.url();
        debug(`Reusing existing browser connection for ${cdpUrl}, page: ${url}`);
        return `Connected. Active page: ${title} (${url})`;
      } catch {
        await this.close();
      }
    }

    try {
      this.browser = await withTimeout(
        chromium.connectOverCDP(cdpUrl),
        CDP_CONNECT_TIMEOUT_MS,
        `Browser CDP connect (${cdpUrl})`,
      );
    } catch (err) {
      throw new Error(
        `Cannot connect to browser at ${cdpUrl}. ` +
          `Use 'launch' action instead, or ensure Brave is running with --remote-debugging-port. ` +
          `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.browser.on("disconnected", () => {
      debug("Browser disconnected");
      this.browser = null;
      this.page = null;
    });

    const contexts = this.browser.contexts();
    const ctx = contexts[0];
    if (!ctx) throw new Error("No browser context found");
    const pages = ctx.pages();
    this.page =
      pages.find((p) => p.url() !== "about:blank") ??
      pages[0] ??
      (await withTimeout(
        ctx.newPage(),
        PAGE_READY_TIMEOUT_MS,
        "Browser newPage",
      ));

    const title = await withTimeout(
      this.page.title(),
      PAGE_READY_TIMEOUT_MS,
      "Browser page title",
    );
    const url = this.page.url();
    debug(`Connected to ${cdpUrl}, page: ${url}`);
    return `Connected. Active page: ${title} (${url})`;
  }

  /** Navigate to a URL. */
  async open(url: string): Promise<string> {
    const page = this.getPage();

    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes("Timeout")) {
        debug(`Navigation timeout for ${url}, page may still be loading`);
      } else {
        throw err;
      }
    }

    // Brief settle time for dynamic content
    await page.waitForTimeout(1500);
    const title = await page.title();
    return `Navigated to: ${title} (${page.url()})`;
  }

  /**
   * Get an accessibility snapshot of the page with numbered refs.
   *
   * Interactive elements are labelled [1], [2], etc. The agent uses these
   * ref numbers with click, fill, type, and select actions.
   *
   * Refs are NOT stable across navigations — always re-snapshot after open/click.
   */
  async snapshot(options?: { interactive?: boolean }): Promise<string> {
    const page = this.getPage();
    const interactiveOnly = options?.interactive ?? false;

    const result = await page.evaluate(
      (intOnly: boolean) => {
        // ---- runs in the browser context ----

        // Clean old refs
        document
          .querySelectorAll("[data-tango-ref]")
          .forEach((el) => el.removeAttribute("data-tango-ref"));

        const SKIP = new Set([
          "SCRIPT",
          "STYLE",
          "NOSCRIPT",
          "SVG",
          "PATH",
          "META",
          "LINK",
          "HEAD",
          "TEMPLATE",
        ]);
        const INTERACTIVE_SELECTOR = [
          "a[href]",
          "button",
          "input:not([type=hidden])",
          "select",
          "textarea",
          "summary",
          "[role=button]",
          "[role=link]",
          "[role=menuitem]",
          "[role=tab]",
          "[role=checkbox]",
          "[role=radio]",
          "[role=combobox]",
          "[role=textbox]",
          "[role=searchbox]",
          "[role=switch]",
        ].join(", ");
        const HEADING_RE = /^H[1-6]$/;
        const MAX_TEXT = 150;
        const MAX_ELEMENTS = 300;

        function isVisible(el: Element): boolean {
          try {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return false;
            const style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden")
              return false;
            if (parseFloat(style.opacity) === 0) return false;
            return true;
          } catch {
            return false;
          }
        }

        function getLabel(el: Element): string {
          const ariaLabel = el.getAttribute("aria-label");
          if (ariaLabel) return ariaLabel.trim().substring(0, MAX_TEXT);

          const ariaLabelledBy = el.getAttribute("aria-labelledby");
          if (ariaLabelledBy) {
            const labelEl = document.getElementById(ariaLabelledBy);
            if (labelEl)
              return labelEl.textContent?.trim().substring(0, MAX_TEXT) || "";
          }

          const inputEl = el as HTMLInputElement;
          if (inputEl.placeholder)
            return inputEl.placeholder.substring(0, MAX_TEXT);

          if (el.id) {
            try {
              const labelFor = document.querySelector(
                `label[for="${CSS.escape(el.id)}"]`,
              );
              if (labelFor)
                return (
                  labelFor.textContent?.trim().substring(0, MAX_TEXT) || ""
                );
            } catch {
              /* ignore CSS.escape issues */
            }
          }

          const title = el.getAttribute("title");
          if (title) return title.substring(0, MAX_TEXT);

          const text = el.textContent?.trim() || "";
          return text.substring(0, MAX_TEXT);
        }

        function getType(el: Element): string {
          const role = el.getAttribute("role");
          if (role) return role;

          switch (el.tagName) {
            case "A":
              return "link";
            case "BUTTON":
              return "button";
            case "INPUT": {
              const t = (el as HTMLInputElement).type;
              if (t === "submit" || t === "button" || t === "reset")
                return "button";
              if (t === "checkbox") return "checkbox";
              if (t === "radio") return "radio";
              if (t === "search") return "searchbox";
              return "textbox";
            }
            case "SELECT":
              return "select";
            case "TEXTAREA":
              return "textbox";
            case "SUMMARY":
              return "button";
            default:
              return el.tagName.toLowerCase();
          }
        }

        // Collect all elements of interest in DOM order
        type Entry =
          | { kind: "heading"; level: number; text: string }
          | { kind: "interactive"; el: Element }
          | { kind: "text"; text: string };

        const entries: Entry[] = [];

        function walk(node: Element, depth: number): void {
          if (entries.length >= MAX_ELEMENTS * 2) return;
          if (SKIP.has(node.tagName)) return;
          if (!isVisible(node)) return;

          // Heading
          if (HEADING_RE.test(node.tagName)) {
            const text = node.textContent?.trim();
            if (text) {
              entries.push({
                kind: "heading",
                level: parseInt(node.tagName[1]!),
                text: text.substring(0, MAX_TEXT),
              });
            }
            return; // Don't recurse into headings
          }

          // Interactive element
          if (node.matches(INTERACTIVE_SELECTOR)) {
            entries.push({ kind: "interactive", el: node });
            return; // Don't recurse — label captures the text
          }

          // Leaf text content (context for the agent)
          if (
            !intOnly &&
            node.childElementCount === 0 &&
            node.textContent?.trim()
          ) {
            const text = node.textContent.trim();
            if (text.length > 2 && text.length <= MAX_TEXT) {
              entries.push({ kind: "text", text });
            }
          }

          // Recurse into children
          for (const child of node.children) {
            walk(child, depth + 1);
          }
        }

        walk(document.body, 0);

        // Format output
        const lines: string[] = [];
        lines.push(`# ${document.title}`);
        lines.push(`URL: ${location.href}`);
        lines.push("");

        let ref = 1;
        let interactiveCount = 0;

        for (const entry of entries) {
          if (entry.kind === "heading") {
            lines.push("");
            lines.push(
              `${"#".repeat(Math.min(entry.level, 4))} ${entry.text}`,
            );
          } else if (entry.kind === "interactive") {
            if (interactiveCount >= MAX_ELEMENTS) continue;
            interactiveCount++;

            const el = entry.el;
            const r = ref++;
            el.setAttribute("data-tango-ref", String(r));

            const type = getType(el);
            const label = getLabel(el);
            const parts: string[] = [`[${r}]`, type];

            if (label) parts.push(`"${label}"`);

            const inputEl = el as HTMLInputElement;
            if (
              inputEl.value &&
              !["BUTTON", "A", "SUMMARY"].includes(el.tagName)
            ) {
              parts.push(`value="${inputEl.value.substring(0, 80)}"`);
            }

            if (inputEl.checked) parts.push("[checked]");
            if (inputEl.disabled || el.hasAttribute("disabled"))
              parts.push("[disabled]");
            if (el.getAttribute("aria-expanded") === "true")
              parts.push("[expanded]");
            if (el.getAttribute("aria-selected") === "true")
              parts.push("[selected]");

            if (el.tagName === "SELECT") {
              const sel = el as HTMLSelectElement;
              const opts = Array.from(sel.options)
                .map((o) => o.text.trim())
                .filter(Boolean)
                .slice(0, 8);
              if (opts.length > 0) parts.push(`options=[${opts.join(", ")}]`);
            }

            lines.push(parts.join(" "));
          } else if (entry.kind === "text") {
            lines.push(`  ${entry.text}`);
          }
        }

        lines.push("");
        lines.push(`--- ${ref - 1} interactive elements ---`);
        return lines.join("\n");
      },
      interactiveOnly,
    );

    return result;
  }

  /** Take a screenshot and save to a temp file. Returns the file path. */
  async screenshot(options?: { fullPage?: boolean; ref?: number; selector?: string }): Promise<string> {
    const page = this.getPage();
    const ts = Date.now();
    const filePath = `/tmp/tango-screenshot-${ts}.png`;

    if (typeof options?.ref === "number") {
      const locator = page.locator(`[data-tango-ref="${options.ref}"]`);
      const count = await locator.count();
      if (count === 0) {
        throw new Error(`Ref ${options.ref} not found. Take a new snapshot before capturing.`);
      }
      await locator.first().screenshot({
        path: filePath,
        type: "png",
      });
      return filePath;
    }

    if (typeof options?.selector === "string" && options.selector.trim().length > 0) {
      const locator = page.locator(options.selector);
      const count = await locator.count();
      if (count === 0) {
        throw new Error(`Selector did not match any elements: ${options.selector}`);
      }
      await locator.first().screenshot({
        path: filePath,
        type: "png",
      });
      return filePath;
    }

    await page.screenshot({
      path: filePath,
      type: "png",
      fullPage: options?.fullPage ?? false,
    });
    return filePath;
  }

  /** Click an element by ref number from the last snapshot. */
  async click(ref: number): Promise<string> {
    const page = this.getPage();
    const locator = page.locator(`[data-tango-ref="${ref}"]`);
    const count = await locator.count();
    if (count === 0)
      throw new Error(
        `Ref ${ref} not found. Take a new snapshot — refs change after navigation.`,
      );

    const tag = await locator.evaluate((el: Element) => el.tagName);
    const label = await locator
      .evaluate(
        (el: Element) =>
          el.getAttribute("aria-label") ||
          el.textContent?.trim().substring(0, 80) ||
          "",
      )
      .catch(() => "");

    await locator.click({ timeout: 10_000 });
    await page.waitForTimeout(500);

    debug(`Clicked [${ref}] ${tag} "${label}"`);
    return `Clicked [${ref}] "${label}"`;
  }

  /** Fill an input by ref. Clears existing value first. */
  async fill(ref: number, value: string): Promise<string> {
    const page = this.getPage();
    const locator = page.locator(`[data-tango-ref="${ref}"]`);
    const count = await locator.count();
    if (count === 0) throw new Error(`Ref ${ref} not found. Re-snapshot.`);

    await locator.fill(value, { timeout: 10_000 });
    return `Filled [${ref}] with "${value}"`;
  }

  /** Upload one or more files into a file input by ref. */
  async upload(ref: number, filePaths: string[]): Promise<string> {
    const page = this.getPage();
    const locator = page.locator(`[data-tango-ref="${ref}"]`);
    const count = await locator.count();
    if (count === 0) {
      throw new Error(`Ref ${ref} not found. Re-snapshot.`);
    }
    if (filePaths.length === 0) {
      throw new Error("upload requires at least one file path");
    }

    await locator.setInputFiles(filePaths);
    return `Uploaded ${filePaths.length} file(s) into [${ref}]`;
  }

  private async collectVisibleViewportText(page: Page): Promise<string> {
    return page.locator("body").evaluate((body) => {
      const parts: string[] = [];
      const seen = new Set<string>();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      for (const element of [body, ...Array.from(body.querySelectorAll("*"))]) {
        const rect = element.getBoundingClientRect();
        if (
          rect.width < 12
          || rect.height < 12
          || rect.bottom <= 0
          || rect.right <= 0
          || rect.top >= viewportHeight
          || rect.left >= viewportWidth
        ) {
          continue;
        }

        const rawText = (element as HTMLElement).innerText ?? element.textContent ?? "";
        const text = rawText.replace(/\s+/gu, " ").trim();
        if (!text || seen.has(text)) {
          continue;
        }
        seen.add(text);
        parts.push(text);
      }

      return parts.join(" | ");
    });
  }

  private async captureWalmartOrderDateSummaryClip(
    page: Page,
    summaryLocator: ReturnType<Page["locator"]>,
    orderId: string | null | undefined,
    filePath: string,
  ): Promise<{
    captureMode: string;
    dateVisible: boolean;
    visibleDateText: string[];
    verificationWarnings: string[];
  } | null> {
    const pageText = await page.locator("body").innerText().catch(() => "");
    const candidateDates = extractWalmartExplicitDates(pageText)
      .filter((value) => parseFlexibleDateToIso(value) != null);
    if (candidateDates.length === 0) {
      return null;
    }

    const summaryBox = await summaryLocator.boundingBox().catch(() => null);
    if (!summaryBox) {
      return null;
    }

    const orderLocator = orderId
      ? page.getByText(new RegExp(`Order#\\s*${escapeRegex(orderId)}`, "iu")).first()
      : page.getByText(/Order#/iu).first();
    const orderBox = await orderLocator.boundingBox().catch(() => null);
    if (!orderBox) {
      return null;
    }

    for (const dateText of candidateDates) {
      const dateLocator = page.getByText(
        new RegExp(`${escapeRegex(dateText)}\\s+order`, "iu"),
      ).first();
      const count = await dateLocator.count().catch(() => 0);
      if (count === 0) {
        continue;
      }
      await dateLocator.waitFor({ state: "visible", timeout: 1_500 }).catch(() => undefined);
      const dateBox = await dateLocator.boundingBox().catch(() => null);
      if (!dateBox) {
        continue;
      }

      const x = Math.max(0, Math.min(dateBox.x, orderBox.x, summaryBox.x) - 24);
      const y = Math.max(0, Math.min(dateBox.y, orderBox.y, summaryBox.y) - 24);
      const right = Math.max(
        dateBox.x + dateBox.width,
        orderBox.x + orderBox.width,
        summaryBox.x + summaryBox.width,
      );
      const bottom = Math.max(
        dateBox.y + dateBox.height,
        orderBox.y + orderBox.height,
        summaryBox.y + summaryBox.height,
      );

      await page.screenshot({
        path: filePath,
        clip: {
          x,
          y,
          width: right - x + 24,
          height: bottom - y + 24,
        },
        type: "png",
      });
      return {
        captureMode: "order-date+payment-summary-clip",
        dateVisible: true,
        visibleDateText: [dateText],
        verificationWarnings: [],
      };
    }

    return null;
  }

  private async captureWalmartViewportEvidence(
    page: Page,
    summaryLocator: ReturnType<Page["locator"]>,
    orderId: string | null | undefined,
    filePath: string,
  ): Promise<{
    captureMode: string;
    dateVisible: boolean;
    visibleDateText: string[];
    verificationWarnings: string[];
  } | null> {
    const summaryBox = await summaryLocator.boundingBox().catch(() => null);
    if (summaryBox) {
      const currentScrollY = await page.evaluate(() => window.scrollY);
      const targetTop = 260;
      const targetScrollY = Math.max(0, currentScrollY + summaryBox.y - targetTop);
      await page.evaluate((scrollY) => {
        window.scrollTo({ top: scrollY, behavior: "auto" });
      }, targetScrollY).catch(() => undefined);
      await page.waitForTimeout(300);
    }

    const visibleText = await this.collectVisibleViewportText(page);
    if (!/driver tip/i.test(visibleText)) {
      return null;
    }
    if (orderId && !new RegExp(`order#?\\s*${escapeRegex(orderId)}`, "iu").test(visibleText)) {
      return null;
    }

    const visibleDateText = extractWalmartExplicitDates(visibleText);
    if (visibleDateText.length === 0) {
      return null;
    }

    await page.screenshot({
      path: filePath,
      type: "png",
    });
    return {
      captureMode: "viewport-with-date-context",
      dateVisible: true,
      visibleDateText,
      verificationWarnings: [],
    };
  }

  async captureWalmartTipEvidence(input: {
    orderUrl: string;
    outputPath?: string;
  }): Promise<{
    orderUrl: string;
    screenshotPath: string;
    sourceScreenshotPath: string;
    tipText: string;
    selectorUsed: string;
    captureMode: string;
    dateVisible: boolean;
    visibleDateText: string[];
    verificationWarnings: string[];
    evidenceSha256: string;
    imageWidth?: number;
    imageHeight?: number;
  }> {
    const page = this.getPage();
    const filePath =
      input.outputPath?.trim() || `/tmp/tango-walmart-tip-${Date.now()}.png`;
    const orderId = extractWalmartOrderIdFromUrl(input.orderUrl);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await page.goto(input.orderUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      }).catch(() => undefined);
      await page.waitForTimeout(attempt === 0 ? 3_000 : 5_000);
      const directCapture = await this.tryCaptureWalmartTipEvidenceFromCurrentPage(page, filePath, orderId);
      if (directCapture) {
        const archivedEvidence = archiveReimbursementEvidence({
          sourcePath: directCapture.sourceScreenshotPath,
          orderId: orderId ?? undefined,
          label: "walmart-tip-evidence",
          metadata: {
            kind: "walmart_tip_evidence",
            orderId: orderId ?? undefined,
            selectorUsed: directCapture.selectorUsed,
            captureMode: directCapture.captureMode,
            dateVisible: directCapture.dateVisible,
            visibleDateText: directCapture.visibleDateText,
            verificationWarnings: directCapture.verificationWarnings,
            capturedAt: new Date().toISOString(),
          },
        });
        return {
          ...directCapture,
          screenshotPath: archivedEvidence.archivedPath,
          evidenceSha256: archivedEvidence.sha256,
          imageWidth: archivedEvidence.imageWidth,
          imageHeight: archivedEvidence.imageHeight,
        };
      }

      const bodyText = (await page.locator("body").innerText().catch(() => "")).trim();
      if (attempt === 0 && /WCP_ORDER_FAIL|try again/iu.test(bodyText)) {
        debug("Walmart order page returned a transient error; retrying evidence capture once.");
      } else {
        break;
      }
    }

    if (orderId) {
      const historyUrl = await this.openWalmartOrderFromPurchaseHistory(page, orderId);
      const historyCapture = await this.tryCaptureWalmartTipEvidenceFromCurrentPage(page, filePath, orderId);
      if (historyCapture) {
        const archivedEvidence = archiveReimbursementEvidence({
          sourcePath: historyCapture.sourceScreenshotPath,
          orderId,
          label: "walmart-tip-evidence",
          metadata: {
            kind: "walmart_tip_evidence",
            orderId,
            selectorUsed: historyCapture.selectorUsed,
            captureMode: historyCapture.captureMode,
            dateVisible: historyCapture.dateVisible,
            visibleDateText: historyCapture.visibleDateText,
            verificationWarnings: historyCapture.verificationWarnings,
            capturedAt: new Date().toISOString(),
          },
        });
        return {
          ...historyCapture,
          orderUrl: historyUrl,
          screenshotPath: archivedEvidence.archivedPath,
          evidenceSha256: archivedEvidence.sha256,
          imageWidth: archivedEvidence.imageWidth,
          imageHeight: archivedEvidence.imageHeight,
        };
      }
    }

    throw new Error(
      "Could not capture a Walmart evidence screenshot that clearly shows Driver tip and an explicit visible date.",
    );
  }

  private async tryCaptureWalmartTipEvidenceFromCurrentPage(
    page: Page,
    filePath: string,
    orderId?: string | null,
  ): Promise<{
    orderUrl: string;
    screenshotPath: string;
    sourceScreenshotPath: string;
    tipText: string;
    selectorUsed: string;
    captureMode: string;
    dateVisible: boolean;
    visibleDateText: string[];
    verificationWarnings: string[];
  } | null> {
    const orderDateLocator = page.getByText(
      /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2},\s+\d{4}\s+order\b/iu,
    ).first();
    await orderDateLocator.waitFor({ state: "visible", timeout: 4_000 }).catch(() => undefined);

    for (const selector of WALMART_PAYMENT_SUMMARY_SELECTORS) {
      const locator = page.locator(selector).first();
      const count = await locator.count().catch(() => 0);
      if (count === 0) continue;
      const text = await locator.innerText().catch(() => "");
      if (!/driver tip/i.test(text)) continue;

      const exactDateCapture = await this.captureWalmartOrderDateSummaryClip(
        page,
        locator,
        orderId,
        filePath,
      );
      if (exactDateCapture) {
        return {
          orderUrl: page.url(),
          screenshotPath: filePath,
          sourceScreenshotPath: filePath,
          tipText: text.trim(),
          selectorUsed: `${selector} -> ${exactDateCapture.captureMode}`,
          captureMode: exactDateCapture.captureMode,
          dateVisible: exactDateCapture.dateVisible,
          visibleDateText: exactDateCapture.visibleDateText,
          verificationWarnings: exactDateCapture.verificationWarnings,
        };
      }

      let headerLocator = orderDateLocator;
      if ((await headerLocator.count().catch(() => 0)) === 0) {
        headerLocator = orderId
          ? page.getByText(new RegExp(`Order#\\s*${escapeRegex(orderId)}`, "iu")).first()
          : page.getByText(/Order#/iu).first();
      }

      const screenshotMode = await this.captureWalmartEvidenceRegion(
        page,
        locator,
        headerLocator,
        orderId,
        filePath,
      );
      if (!screenshotMode) {
        continue;
      }

      return {
        orderUrl: page.url(),
        screenshotPath: filePath,
        sourceScreenshotPath: filePath,
        tipText: text.trim(),
        selectorUsed: `${selector} -> ${screenshotMode.captureMode}`,
        captureMode: screenshotMode.captureMode,
        dateVisible: screenshotMode.dateVisible,
        visibleDateText: screenshotMode.visibleDateText,
        verificationWarnings: screenshotMode.verificationWarnings,
      };
    }

    return null;
  }

  private async captureWalmartEvidenceRegion(
    page: Page,
    summaryLocator: ReturnType<Page["locator"]>,
    headerLocator: ReturnType<Page["getByText"]>,
    orderId: string | null | undefined,
    filePath: string,
  ): Promise<{
    captureMode: string;
    dateVisible: boolean;
    visibleDateText: string[];
    verificationWarnings: string[];
  } | null> {
    const readPageRect = async (
      locator: ReturnType<Page["locator"]> | ReturnType<Page["getByText"]>,
      options: { preferDateContext?: boolean } = {},
    ): Promise<{
      x: number;
      y: number;
      width: number;
      height: number;
      text: string;
    } | null> =>
      locator
        .evaluate((element, preferDateContext) => {
          const normalize = (value: string | null | undefined) =>
            (value ?? "").replace(/\s+/gu, " ").trim();
          const hasExplicitDate = (value: string) =>
            /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:,\s*\d{4})?|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/iu.test(
              value,
            );
          let candidate: Element = element;
          if (preferDateContext) {
            let current = element.parentElement;
            while (current) {
              const text = normalize(current.textContent);
              const rect = current.getBoundingClientRect();
              if (
                rect.width > 0
                && rect.height > 0
                && /order#/iu.test(text)
                && hasExplicitDate(text)
              ) {
                candidate = current;
                break;
              }
              current = current.parentElement;
            }
          }
          const rect = candidate.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) {
            return null;
          }
          return {
            x: window.scrollX + rect.x,
            y: window.scrollY + rect.y,
            width: rect.width,
            height: rect.height,
            text: normalize(candidate.textContent),
          };
        }, options.preferDateContext === true)
        .catch(() => null);

    const summaryBox = await readPageRect(summaryLocator);
    const headerBox = await readPageRect(headerLocator, { preferDateContext: true });
    const orderIdBox = orderId
      ? await readPageRect(page.getByText(new RegExp(`Order#\\s*${escapeRegex(orderId)}`, "iu")).first())
      : null;
    if (summaryBox && headerBox) {
      const clipLeft = Math.max(
        0,
        Math.min(summaryBox.x, headerBox.x, orderIdBox?.x ?? Number.POSITIVE_INFINITY) - 24,
      );
      const clipTop = Math.max(
        0,
        Math.min(summaryBox.y, headerBox.y, orderIdBox?.y ?? Number.POSITIVE_INFINITY) - 24,
      );
      const clipRight = Math.max(
        summaryBox.x + summaryBox.width,
        headerBox.x + headerBox.width,
        orderIdBox ? orderIdBox.x + orderIdBox.width : 0,
      );
      const clipBottom = Math.max(
        summaryBox.y + summaryBox.height,
        headerBox.y + headerBox.height,
        orderIdBox ? orderIdBox.y + orderIdBox.height : 0,
      );
      await page.screenshot({
        path: filePath,
        clip: {
          x: clipLeft,
          y: clipTop,
          width: clipRight - clipLeft + 24,
          height: clipBottom - clipTop + 24,
        },
        type: "png",
      });
      const visibleDateText = extractWalmartExplicitDates(
        `${headerBox.text} ${orderIdBox?.text ?? ""} ${await summaryLocator.innerText().catch(() => "")}`,
      );
      if (visibleDateText.length > 0) {
        return {
          captureMode: orderIdBox ? "order-date+payment-summary-clip" : "order-header+payment-summary-clip",
          dateVisible: true,
          visibleDateText,
          verificationWarnings: [],
        };
      }
    }
    if (summaryBox && headerBox) {
      const headerText = headerBox.text.trim();
      const clip = {
        x: Math.max(0, Math.min(summaryBox.x, headerBox.x) - 24),
        y: Math.max(0, Math.min(summaryBox.y, headerBox.y) - 24),
        width: Math.max(summaryBox.x + summaryBox.width, headerBox.x + headerBox.width)
          - Math.max(0, Math.min(summaryBox.x, headerBox.x) - 24)
          + 24,
        height: Math.max(summaryBox.y + summaryBox.height, headerBox.y + headerBox.height)
          - Math.max(0, Math.min(summaryBox.y, headerBox.y) - 24)
          + 24,
      };
      await page.screenshot({
        path: filePath,
        clip,
        type: "png",
      });
      const visibleDateText = extractWalmartExplicitDates(`${headerText} ${await summaryLocator.innerText().catch(() => "")}`);
      if (visibleDateText.length > 0) {
        return {
          captureMode: "order-header+payment-summary-clip",
          dateVisible: true,
          visibleDateText,
          verificationWarnings: [],
        };
      }
    }

    const viewportCapture = await this.captureWalmartViewportEvidence(
      page,
      summaryLocator,
      orderId,
      filePath,
    );
    if (viewportCapture) {
      return viewportCapture;
    }

    const captureMeta = await summaryLocator.evaluate((el) => {
      const normalize = (value: string | null | undefined) =>
        (value ?? "").replace(/\s+/gu, " ").trim();
      let candidate: Element = el;
      let current = el.parentElement;
      while (current) {
        const text = normalize(current.textContent);
        const rect = current.getBoundingClientRect();
        if (
          /driver tip/i.test(text)
          && rect.width >= 240
          && rect.height >= 120
          && rect.height <= 2200
          && /(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})/iu.test(text)
        ) {
          candidate = current;
          break;
        }
        current = current.parentElement;
      }

      candidate.setAttribute("data-tango-reimbursement-capture", "1");
      return {
        candidateText: normalize(candidate.textContent),
        usedAncestor: candidate !== el,
      };
    });

    const captureLocator = page.locator('[data-tango-reimbursement-capture="1"]').first();
    try {
      await captureLocator.screenshot({ path: filePath, type: "png" });
    } finally {
      await page.locator('[data-tango-reimbursement-capture="1"]').evaluateAll((elements) => {
        for (const element of elements) {
          element.removeAttribute("data-tango-reimbursement-capture");
        }
      }).catch(() => undefined);
    }

    const visibleDateText = extractWalmartExplicitDates(captureMeta.candidateText);
    if (visibleDateText.length > 0) {
      return {
        captureMode: "ancestor-with-date-context",
        dateVisible: true,
        visibleDateText,
        verificationWarnings: [],
      };
    }

    return null;
  }

  private async openWalmartOrderFromPurchaseHistory(page: Page, orderId: string): Promise<string> {
    const flatOrderId = flattenWalmartOrderId(orderId);
    await page.goto("https://www.walmart.com/orders", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    }).catch(() => undefined);
    await page.waitForTimeout(4_000);
    await page
      .waitForSelector('[data-automation-id^="view-order-details-link-"]', {
        timeout: 12_000,
      })
      .catch(() => undefined);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const exactSelector = `[data-automation-id="view-order-details-link-${flatOrderId}"]`;
      let button = page.locator(exactSelector).first();
      if ((await button.count().catch(() => 0)) === 0) {
        const matchedAutomationId = await page
          .locator('[data-automation-id^="view-order-details-link-"]')
          .evaluateAll((elements, targetOrderId) => {
            const target = String(targetOrderId ?? "");
            for (const element of elements) {
              const automationId = element.getAttribute("data-automation-id");
              if (automationId?.includes(target)) {
                return automationId;
              }
            }
            return null;
          }, flatOrderId)
          .catch(() => null);
        if (matchedAutomationId) {
          button = page.locator(`[data-automation-id="${matchedAutomationId}"]`).first();
        }
      }
      if ((await button.count().catch(() => 0)) > 0) {
        await button.scrollIntoViewIfNeeded().catch(() => undefined);
        await page.waitForTimeout(500);
        await button.click({ timeout: 10_000 }).catch(() => undefined);
        await page.waitForTimeout(6_000);
        return page.url();
      }
      await page.mouse.wheel(0, 1600);
      await page.waitForTimeout(1_200);
    }

    throw new Error(`Could not find Walmart purchase-history card for order ${orderId}.`);
  }

  private parseCurrencyFromText(text: string, patterns: RegExp[]): number | undefined {
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (!match?.[1]) {
        continue;
      }
      const parsed = Number.parseFloat(match[1].replace(/[$,]/gu, ""));
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return undefined;
  }

  private async collectWalmartHistoryPageEntries(page: Page): Promise<Array<{
    orderId: string;
    orderUrl: string;
    cardText: string;
    automationId: string;
  }>> {
    const entries = await page
      .locator('[data-automation-id^="view-order-details-link-"]')
      .evaluateAll((elements) => {
        const results: Array<{
          orderId: string;
          orderUrl: string;
          cardText: string;
          automationId: string;
        }> = [];
        for (const element of elements) {
          const href = typeof (element as { href?: unknown }).href === "string"
            ? String((element as { href?: unknown }).href)
            : "";
          const automationId = element.getAttribute("data-automation-id") || "";
          const rawOrder =
            href.match(/\/orders\/([0-9-]{10,})/i)?.[1]
            || automationId.replace(/^view-order-details-link-/i, "");
          const flat = rawOrder.replace(/\D/g, "");
          if (flat.length < 15) {
            continue;
          }
          const orderId = `${flat.slice(0, 7)}-${flat.slice(7, 15)}`;
          let card: Element | null = element.parentElement;
          let bestText = "";
          while (card && card !== document.body) {
            const text = (card.textContent || "").replace(/\s+/gu, " ").trim();
            if (text.length > bestText.length) {
              bestText = text;
            }
            if (text.length >= 40 && /delivery|pickup|store purchase|shipping/i.test(text)) {
              bestText = text;
              break;
            }
            card = card.parentElement;
          }
          const cardText = bestText;
          results.push({
            orderId,
            orderUrl: href,
            cardText,
            automationId,
          });
        }
        return results;
      })
      .catch(() => []);

    const deduped = new Map<string, { orderId: string; orderUrl: string; cardText: string; automationId: string }>();
    for (const entry of entries) {
      if (!deduped.has(entry.orderId)) {
        deduped.set(entry.orderId, entry);
      }
    }
    return [...deduped.values()];
  }

  private async openNextWalmartHistoryPage(page: Page): Promise<boolean> {
    const nextButton = page.getByRole("button", { name: /next page/i }).first();
    if ((await nextButton.count().catch(() => 0)) === 0) {
      return false;
    }
    const disabled = await nextButton.isDisabled().catch(() => true);
    if (disabled) {
      return false;
    }
    await nextButton.click({ timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(3_500);
    return true;
  }

  private async inspectWalmartHistoryEntry(
    page: Page,
    entry: { orderId: string; orderUrl: string; cardText: string; automationId: string },
  ): Promise<WalmartHistoryCandidate | null> {
    const detailPage = await page.context().newPage();
    try {
      const targetUrl = entry.orderUrl || `https://www.walmart.com/orders/${flattenWalmartOrderId(entry.orderId)}`;
      await detailPage.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      }).catch(() => undefined);
      await detailPage.waitForTimeout(4_000);

      if (!/\/orders\/[0-9]+/i.test(detailPage.url())) {
        return null;
      }

      const bodyText = await detailPage.locator("body").innerText().catch(() => "");
      if (!/delivery from store/i.test(bodyText)) {
        return null;
      }

      const orderDateLocator = detailPage.getByText(
        /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2},\s+\d{4}\s+order\b/iu,
      ).first();
      const orderDateText = (
        await orderDateLocator.innerText().catch(() => "")
      ).replace(/\s+order$/iu, "").trim();
      const fallbackDateText = extractWalmartExplicitDates(bodyText).find((value) => parseFlexibleDateToIso(value) != null) ?? "";
      const dateText = orderDateText || fallbackDateText;
      const date = parseFlexibleDateToIso(dateText);
      if (!date) {
        return null;
      }

      const summaryText = await detailPage
        .locator(WALMART_PAYMENT_SUMMARY_SELECTORS.join(", "))
        .first()
        .innerText()
        .catch(() => "");
      const combinedText = `${summaryText}\n${bodyText}`;
      const driverTip = this.parseCurrencyFromText(combinedText, [
        /driver tip\s*\$([0-9.,]+)/iu,
        /driver tip:\s*\$([0-9.,]+)/iu,
        /\|\s*Driver tip\s*\|\s*\$([0-9.,]+)\s*\|/iu,
      ]);
      if (driverTip == null || driverTip <= 0) {
        return null;
      }

      const total = this.parseCurrencyFromText(combinedText, [
        /\bTotal\s*\$([0-9.,]+)/iu,
      ]);
      const temporaryHold = this.parseCurrencyFromText(combinedText, [
        /temporary hold\s*\$([0-9.,]+)/iu,
        /temporary adjusted total\s*\$([0-9.,]+)/iu,
      ]);
      const bagFee = this.parseCurrencyFromText(combinedText, [/bag fee\s*\$([0-9.,]+)/iu]);
      const speedFee = this.parseCurrencyFromText(combinedText, [
        /3 hours or less fee\s*\$([0-9.,]+)/iu,
      ]);
      const subtotal = this.parseCurrencyFromText(combinedText, [
        /subtotal\s*\$([0-9.,]+)/iu,
        /items subtotal\s*\$([0-9.,]+)/iu,
      ]);
      const receivedMatch = /(\d+\s+received(?:\s+\([^)]+\))?)/iu.exec(combinedText);
      const itemsLine = receivedMatch?.[1]?.trim();

      const noteParts = [
        "Delivery from store.",
        `Delivered on ${dateText}.`,
        subtotal != null ? `Subtotal $${subtotal.toFixed(2)}.` : null,
        speedFee != null ? `3 hours or less fee $${speedFee.toFixed(2)}.` : null,
        bagFee != null ? `Bag fee $${bagFee.toFixed(2)}.` : null,
        `Driver tip $${driverTip.toFixed(2)} charged separately after delivery.`,
      ].filter((value): value is string => Boolean(value));

      return {
        orderId: normalizeWalmartOrderId(entry.orderId),
        orderUrl: detailPage.url(),
        date,
        dateText,
        driverTip,
        total,
        cardCharge: total != null
          ? `$${total.toFixed(2)}${temporaryHold != null ? ` (temporary hold $${temporaryHold.toFixed(2)} shown; updated charge may appear within 10 business days)` : ""}`
          : undefined,
        itemsLine,
        deliverySummary: "Delivery from store",
        notes: noteParts.join(" "),
      };
    } finally {
      await detailPage.close().catch(() => undefined);
    }
  }

  async discoverWalmartDeliveryCandidates(input?: {
    since?: string;
    until?: string;
    maxPages?: number;
  }): Promise<WalmartHistoryCandidate[]> {
    const page = this.getPage();
    const since = input?.since?.trim() || null;
    const until = input?.until?.trim() || null;
    const maxPages = Math.max(1, Math.min(input?.maxPages ?? 8, 20));
    const candidates = new Map<string, WalmartHistoryCandidate>();

    await page.goto("https://www.walmart.com/orders", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    }).catch(() => undefined);
    await page.waitForTimeout(4_000);

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const entries = await this.collectWalmartHistoryPageEntries(page);
      for (const entry of entries) {
        if (candidates.has(entry.orderId)) {
          continue;
        }
        const detail = await this.inspectWalmartHistoryEntry(page, entry);
        if (!detail) {
          continue;
        }
        if (since && detail.date < since) {
          continue;
        }
        if (until && detail.date > until) {
          continue;
        }
        candidates.set(detail.orderId, detail);
      }

      if (!(await this.openNextWalmartHistoryPage(page))) {
        break;
      }
    }

    return [...candidates.values()].sort((left, right) => left.date.localeCompare(right.date));
  }

  private buildRampHistoryRecordFromRow(input: {
    reviewUrl: string;
    cells: string[];
  }): RampReimbursementHistoryRecord | null {
    const reviewUrl = input.reviewUrl.trim();
    if (!reviewUrl) {
      return null;
    }

    const cell = (index: number): string | undefined => normalizeRampHistoryCell(input.cells[index]);
    const submittedDateText = cell(5);
    const transactionDateText = cell(6);
    const reviewedDateText = cell(7);
    const expectedPaymentDateText = cell(25);
    const deliveredPaymentDateText = cell(26);

    return {
      reviewUrl,
      rampReportId: extractRampReimbursementIdFromUrl(reviewUrl) ?? undefined,
      user: cell(2),
      status: cell(3),
      receipt: cell(4),
      submittedDate: submittedDateText ? parseFlexibleDateToIso(submittedDateText) ?? submittedDateText : undefined,
      transactionDate: transactionDateText ? parseFlexibleDateToIso(transactionDateText) ?? transactionDateText : undefined,
      reviewedDate: reviewedDateText ? parseFlexibleDateToIso(reviewedDateText) ?? reviewedDateText : undefined,
      merchant: cell(8),
      amount: parseRampHistoryAmount(cell(9)),
      statementAmount: parseRampHistoryAmount(cell(10)),
      entity: cell(11),
      flags: cell(12),
      memo: cell(13),
      reviewer: cell(24),
      expectedPaymentDate: expectedPaymentDateText
        ? parseFlexibleDateToIso(expectedPaymentDateText) ?? expectedPaymentDateText
        : undefined,
      deliveredPaymentDate: deliveredPaymentDateText
        ? parseFlexibleDateToIso(deliveredPaymentDateText) ?? deliveredPaymentDateText
        : undefined,
    };
  }

  private async readVisibleRampHistoryRows(page: Page): Promise<Array<{
    reviewUrl: string;
    cells: string[];
  }>> {
    return page.evaluate(() =>
      [...document.querySelectorAll("tbody tr")]
        .map((row) => {
          const reviewAnchor =
            row.querySelector('a[href*="/details/list/reimbursement/"]')
            ?? row.querySelector('a[href*="/details/reimbursements/"]');
          const reviewUrl =
            reviewAnchor instanceof HTMLAnchorElement
              ? reviewAnchor.href
              : "";
          const cells = [...row.querySelectorAll("td")].map((cell) =>
            (cell.textContent ?? "").replace(/\s+/gu, " ").trim()
          );
          return { reviewUrl, cells };
        })
        .filter((row) => row.reviewUrl.length > 0 && row.cells.some((cell) => cell.length > 0)),
    ).catch(() => []);
  }

  private async collectRampHistoryPageRecords(page: Page): Promise<RampReimbursementHistoryRecord[]> {
    await page.waitForFunction(
      () =>
        document.querySelector('tbody tr a[href*="/details/list/reimbursement/"]')
        || document.querySelector('tbody tr a[href*="/details/reimbursements/"]'),
      { timeout: 20_000 },
    ).catch(() => undefined);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" })).catch(() => undefined);
    await page.waitForTimeout(300);

    const records = new Map<string, RampReimbursementHistoryRecord>();
    let stagnantPasses = 0;
    let lastCount = 0;

    for (let pass = 0; pass < 24; pass += 1) {
      const rows = await this.readVisibleRampHistoryRows(page);
      for (const row of rows) {
        const parsed = this.buildRampHistoryRecordFromRow(row);
        if (!parsed) {
          continue;
        }
        records.set(parsed.reviewUrl, parsed);
      }

      if (records.size === lastCount) {
        stagnantPasses += 1;
      } else {
        stagnantPasses = 0;
        lastCount = records.size;
      }

      const canScrollFurther = await page.evaluate(() =>
        window.scrollY + window.innerHeight + 24 < document.documentElement.scrollHeight,
      ).catch(() => false);
      if (!canScrollFurther && stagnantPasses >= 1) {
        break;
      }

      await page.mouse.wheel(0, 720);
      await page.waitForTimeout(600);
    }

    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" })).catch(() => undefined);
    await page.waitForTimeout(250);
    return [...records.values()];
  }

  private async openNextRampHistoryPage(page: Page): Promise<boolean> {
    const nextButton = page.getByRole("button", { name: /^Next \d+-\d+$/u }).first();
    if ((await nextButton.count().catch(() => 0)) === 0) {
      return false;
    }
    const disabled = await nextButton.isDisabled().catch(() => true);
    if (disabled) {
      return false;
    }

    const previousFirstHref = await page
      .locator('tbody tr a[href*="/details/list/reimbursement/"], tbody tr a[href*="/details/reimbursements/"]')
      .first()
      .getAttribute("href")
      .catch(() => null);

    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" })).catch(() => undefined);
    await page.waitForTimeout(250);
    await nextButton.click({ timeout: 10_000 }).catch(() => undefined);
    await page.waitForFunction(
      (previousHref) => {
        const currentHref =
          document.querySelector('tbody tr a[href*="/details/list/reimbursement/"]')?.getAttribute("href")
          ?? document.querySelector('tbody tr a[href*="/details/reimbursements/"]')?.getAttribute("href")
          ?? null;
        return currentHref != null && currentHref !== previousHref;
      },
      previousFirstHref,
      { timeout: 20_000 },
    ).catch(() => undefined);
    await page.waitForFunction(
      () =>
        document.querySelector('tbody tr a[href*="/details/list/reimbursement/"]')
        || document.querySelector('tbody tr a[href*="/details/reimbursements/"]'),
      { timeout: 20_000 },
    ).catch(() => undefined);
    await page.waitForTimeout(1_500);
    return true;
  }

  async listRampReimbursementHistory(input?: {
    maxPages?: number;
  }): Promise<RampReimbursementHistoryRecord[]> {
    const page = this.getPage();
    const maxPages = Math.max(1, Math.min(input?.maxPages ?? 3, 10));
    const records = new Map<string, RampReimbursementHistoryRecord>();

    await page.goto("https://app.ramp.com/expenses/reimbursements/history", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    }).catch(() => undefined);
    await page.waitForTimeout(3_000);
    await this.assertRampPageAuthenticated(page, "inspect Ramp reimbursement history");
    await page.locator("table").first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);
    await page.waitForFunction(
      () =>
        document.querySelector('tbody tr a[href*="/details/list/reimbursement/"]')
        || document.querySelector('tbody tr a[href*="/details/reimbursements/"]'),
      { timeout: 20_000 },
    ).catch(() => undefined);
    await page.waitForTimeout(2_000);

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const pageRecords = await this.collectRampHistoryPageRecords(page);
      for (const record of pageRecords) {
        records.set(record.reviewUrl, record);
      }

      if (!(await this.openNextRampHistoryPage(page))) {
        break;
      }
    }

    return [...records.values()].sort((left, right) =>
      `${right.submittedDate ?? ""}::${right.transactionDate ?? ""}`.localeCompare(
        `${left.submittedDate ?? ""}::${left.transactionDate ?? ""}`,
      ),
    );
  }

  /**
   * Type text character-by-character into an element.
   * Useful for inputs with autocomplete/live search that need keystroke events.
   */
  async type(ref: number, text: string): Promise<string> {
    const page = this.getPage();
    const locator = page.locator(`[data-tango-ref="${ref}"]`);
    const count = await locator.count();
    if (count === 0) throw new Error(`Ref ${ref} not found. Re-snapshot.`);

    await locator.click({ timeout: 5_000 });
    await locator.pressSequentially(text, { delay: 50, timeout: 30_000 });
    return `Typed "${text}" into [${ref}]`;
  }

  /** Press a keyboard key (Enter, Tab, Escape, ArrowDown, etc.) */
  async press(key: string): Promise<string> {
    const page = this.getPage();
    await page.keyboard.press(key);
    await page.waitForTimeout(300);
    return `Pressed ${key}`;
  }

  /** Select option(s) from a <select> by ref. */
  async select(ref: number, values: string[]): Promise<string> {
    const page = this.getPage();
    const locator = page.locator(`[data-tango-ref="${ref}"]`);
    const count = await locator.count();
    if (count === 0) throw new Error(`Ref ${ref} not found. Re-snapshot.`);

    await locator.selectOption(values, { timeout: 10_000 });
    return `Selected "${values.join(", ")}" in [${ref}]`;
  }

  /** Scroll the page up or down. */
  async scroll(direction: "up" | "down", pixels?: number): Promise<string> {
    const page = this.getPage();
    const amount = pixels ?? 600;
    const delta = direction === "down" ? amount : -amount;
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(500);
    return `Scrolled ${direction} ${amount}px`;
  }

  /** Wait for a condition: text on page, CSS selector, or plain timeout (ms). */
  async wait(options: {
    selector?: string;
    text?: string;
    timeout?: number;
  }): Promise<string> {
    const page = this.getPage();
    const timeoutMs = options.timeout ?? 10_000;

    if (options.selector) {
      await page.waitForSelector(options.selector, {
        timeout: timeoutMs,
      });
      return `Found selector: ${options.selector}`;
    }

    if (options.text) {
      await page.waitForFunction(
        (t: string) => document.body.textContent?.includes(t) ?? false,
        options.text,
        { timeout: timeoutMs },
      );
      return `Found text: "${options.text}"`;
    }

    await page.waitForTimeout(timeoutMs);
    return `Waited ${timeoutMs}ms`;
  }

  /** Evaluate JavaScript in the page context. Returns the result. */
  async evaluate(script: string): Promise<unknown> {
    const page = this.getPage();
    return page.evaluate(script);
  }

  private async selectRampMerchant(page: Page, merchant: string): Promise<void> {
    const merchantButton = page.locator('div[name="merchant"] button').first();
    await merchantButton.click();
    await page.waitForTimeout(500);

    const searchInputs = [
      page.locator('div[name="merchant"] input').first(),
      page.getByRole("combobox").first(),
      page.locator('input[placeholder*="search" i]').first(),
    ];

    for (const candidate of buildRampMerchantCandidates(merchant)) {
      for (const input of searchInputs) {
        if ((await input.count().catch(() => 0)) === 0) {
          continue;
        }
        await input.fill(candidate).catch(() => undefined);
        await page.waitForTimeout(350);
      }

      const option = page.getByRole("option", { name: new RegExp(escapeRegex(candidate), "i") }).first();
      if ((await option.count().catch(() => 0)) > 0) {
        await option.click();
        return;
      }
    }

    const visibleOptions = page.getByRole("option");
    if ((await visibleOptions.count().catch(() => 0)) === 1) {
      await visibleOptions.first().click();
      return;
    }

    throw new Error(`Could not select Ramp merchant for '${merchant}'.`);
  }

  async captureEmailReimbursementEvidence(input: {
    emailContent: string;
    label?: string;
    outputPath?: string;
  }): Promise<{
    screenshotPath: string;
    archivedPath: string;
    sha256: string;
    imageWidth?: number;
    imageHeight?: number;
    bodyFormat: "html" | "text";
    subject?: string;
    date?: string;
    from?: string;
  }> {
    const page = this.getPage();
    const parsed = parseGogEmailFullOutput(input.emailContent);
    const html = buildEmailEvidenceHtml(parsed);
    const tempHtmlPath = path.join("/tmp", `ramp-email-evidence-${Date.now()}.html`);
    const tempPngPath = input.outputPath
      ? path.resolve(input.outputPath)
      : path.join("/tmp", `ramp-email-evidence-${Date.now()}.png`);
    fs.writeFileSync(tempHtmlPath, html, "utf8");

    await page.goto(`file://${tempHtmlPath}`, {
      waitUntil: "load",
      timeout: 30_000,
    });
    await page.setViewportSize({ width: 1280, height: 1600 }).catch(() => undefined);
    await page.waitForTimeout(750);
    await page.screenshot({
      path: tempPngPath,
      type: "png",
      fullPage: true,
    });

    const archived = archiveReimbursementEvidence({
      sourcePath: tempPngPath,
      label: input.label ?? "email-receipt-evidence",
      metadata: {
        kind: "email_receipt_evidence",
        capturedAt: new Date().toISOString(),
      },
    });

    return {
      screenshotPath: tempPngPath,
      archivedPath: archived.archivedPath,
      sha256: archived.sha256,
      imageWidth: archived.imageWidth,
      imageHeight: archived.imageHeight,
      bodyFormat: parsed.bodyFormat,
      subject: parsed.headers["subject"],
      date: parsed.headers["date"],
      from: parsed.headers["from"],
    };
  }

  private async captureRampConfirmationScreenshot(
    page: Page,
    evidencePath: string,
    label: string,
  ): Promise<{
    archivedPath: string;
    sha256: string;
    imageWidth?: number;
    imageHeight?: number;
  }> {
    const tempPath = `/tmp/${label}-${Date.now()}.png`;
    await page.screenshot({
      path: tempPath,
      type: "png",
    });
    const evidenceRecord = loadReimbursementEvidenceRecord(evidencePath);
    const confirmationRecord = archiveReimbursementEvidence({
      sourcePath: tempPath,
      orderId: evidenceRecord?.orderId,
      label,
      metadata: {
        kind: "ramp_confirmation",
        capturedAt: new Date().toISOString(),
      },
    });
    return {
      archivedPath: confirmationRecord.archivedPath,
      sha256: confirmationRecord.sha256,
      imageWidth: confirmationRecord.imageWidth,
      imageHeight: confirmationRecord.imageHeight,
    };
  }

  private async readRampReviewVisualState(page: Page): Promise<ReturnType<typeof buildRampReviewVisualState>> {
    const images = await page.evaluate(() =>
      [...document.querySelectorAll("img")].map((image) => ({
        src: (image as HTMLImageElement).currentSrc || image.getAttribute("src") || "",
        alt: image.getAttribute("alt") || "",
        width: image.clientWidth,
        height: image.clientHeight,
        naturalWidth: (image as HTMLImageElement).naturalWidth,
        naturalHeight: (image as HTMLImageElement).naturalHeight,
      })),
    ).catch(() => []);
    return buildRampReviewVisualState(images);
  }

  private async assertRampPageAuthenticated(page: Page, action: string): Promise<void> {
    const [title, body] = await Promise.all([
      page.title().catch(() => ""),
      page.locator("body").innerText().catch(() => ""),
    ]);
    if (rampPageLooksSignedOut({ url: page.url(), title, text: body })) {
      throw new Error(
        `Ramp authentication is required to ${action}. Sign in to Ramp in the managed Brave profile and retry.`,
      );
    }
  }

  private async ensureRampReceiptFileInput(page: Page): Promise<void> {
    const fileInput = page.locator('input[type="file"]').first();
    if ((await fileInput.count().catch(() => 0)) > 0) {
      return;
    }

    const triggerLocators = [
      page.getByRole("button", { name: /upload/i }).first(),
      page.getByRole("button", { name: /replace/i }).first(),
      page.getByRole("button", { name: /change/i }).first(),
      page.getByRole("button", { name: /edit/i }).first(),
      page.getByRole("button", { name: /add/i }).first(),
      page.locator('[data-testid*="upload" i]').first(),
      page.locator('[data-testid*="receipt" i]').first(),
      page.locator('[aria-label*="upload" i]').first(),
      page.locator('[aria-label*="receipt" i]').first(),
      page.locator('[title*="upload" i]').first(),
      page.locator('[title*="receipt" i]').first(),
    ];

    for (const locator of triggerLocators) {
      if ((await locator.count().catch(() => 0)) === 0) {
        continue;
      }
      await locator.click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(750);
      if ((await fileInput.count().catch(() => 0)) > 0) {
        return;
      }
    }
  }

  async submitRampReimbursement(input: {
    amount: number;
    transactionDate: string;
    memo: string;
    evidencePath: string;
    merchant?: string;
  }): Promise<{
    reviewUrl: string;
    rampReportId: string;
    amount: number;
    transactionDate: string;
    memo: string;
    evidencePath: string;
    evidenceSha256: string;
    evidenceImageWidth?: number;
    evidenceImageHeight?: number;
    rampConfirmationPath: string;
  }> {
    const page = this.getPage();
    const merchant = (input.merchant ?? "Walmart").trim();
    const isWalmartEvidence = /\bwalmart\b/iu.test(merchant);
    const evidenceRecord = archiveReimbursementEvidence({
      sourcePath: input.evidencePath,
      label: isWalmartEvidence ? "walmart-tip-evidence" : "ramp-reimbursement-evidence",
      metadata: {
        kind: isWalmartEvidence ? "walmart_tip_evidence" : "ramp_reimbursement_evidence",
      },
    });
    await page.goto("https://app.ramp.com/details/reimbursements/new", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    }).catch(() => undefined);
    await page.waitForTimeout(1_000);
    await this.assertRampPageAuthenticated(page, "submit a Ramp reimbursement");
    await page.locator('input[type="file"]').first().setInputFiles([evidenceRecord.archivedPath]);
    await page.waitForURL(/\/details\/reimbursements\/.+\/draft/, {
      timeout: 120_000,
    });
    await page.waitForTimeout(3_000);

    const createdDraftUrl = page.url();
    const createdRampReportId = extractRampReimbursementIdFromUrl(createdDraftUrl);
    if (!createdRampReportId) {
      throw new Error(`Could not extract Ramp reimbursement id from ${createdDraftUrl}`);
    }

    // Wait for the Ramp draft form to fully render and the OCR overlay to clear.
    await page.locator('input[name="amount"]').waitFor({ state: "visible", timeout: 60_000 });
    await page.locator('input[name="Memo"]').first().waitFor({ state: "visible", timeout: 30_000 });
    // Ramp shows a processing overlay while analyzing the receipt — wait for inputs to become actionable.
    await page
      .locator('input[name="amount"]')
      .click({ timeout: 60_000, trial: true })
      .catch(() => undefined);
    await page.locator('input[name="amount"]').fill(input.amount.toFixed(2));
    await page
      .locator('input[name="transaction_date"]')
      .fill(formatRampTransactionDate(input.transactionDate));
    const memoInput = page.locator('input[name="Memo"]').first();
    const ensureMemoValue = async (): Promise<void> => {
      await memoInput.fill(input.memo);
      await memoInput.press("Tab").catch(() => undefined);
      await page.waitForTimeout(250);
      const currentValue = await memoInput.inputValue().catch(() => "");
      if (currentValue.trim() !== input.memo.trim()) {
        await memoInput.fill(input.memo);
        await page.locator("body").click({ position: { x: 20, y: 20 } }).catch(() => undefined);
        await page.waitForTimeout(250);
      }
    };
    await ensureMemoValue();

    try {
      await this.selectRampMerchant(page, merchant);
      await page.waitForTimeout(1_200);
    } catch (error) {
      debug(
        `Continuing Ramp reimbursement without explicit merchant selection for '${merchant}': ${error instanceof Error ? error.message : String(error)}`,
      );
      await page.keyboard.press("Escape").catch(() => undefined);
    }

    const spendAllocation = page.locator('div[name="spend_allocation"] button').first();
    if ((await spendAllocation.count().catch(() => 0)) > 0) {
      const disabled = await spendAllocation.isDisabled().catch(() => false);
      if (!disabled) {
        await spendAllocation.click().catch(() => undefined);
        await page.waitForTimeout(500);
        const noneOption = page.getByRole("option", { name: /^None/i }).first();
        if ((await noneOption.count().catch(() => 0)) > 0) {
          await noneOption.click().catch(() => undefined);
          await page.waitForTimeout(500);
        }
      }
    }

    await ensureMemoValue();

    await page.getByRole("button", { name: /Submit/i }).first().click({
      timeout: 10_000,
      force: true,
    });
    await page.waitForTimeout(4_000);

    const rampReportId = createdRampReportId;
    const reviewUrl = buildRampReviewUrl(rampReportId);
    await page.goto(reviewUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    }).catch(() => undefined);
    await page.waitForTimeout(2_000);
    await this.assertRampPageAuthenticated(page, "open the Ramp reimbursement review page");
    const reviewBody = await page.locator("body").innerText().catch(() => "");
    if (!rampReimbursementLooksSubmitted(reviewBody)) {
      const memoValue = await memoInput.inputValue().catch(() => "");
      if (memoValue.trim().length === 0 || /\bmemo \(required\)\b/iu.test(reviewBody)) {
        throw new Error("Ramp reimbursement draft still requires a memo before submit.");
      }
      throw new Error("Ramp reimbursement submit did not reach a submitted review state.");
    }
    const confirmationScreenshot = await this.captureRampConfirmationScreenshot(
      page,
      evidenceRecord.archivedPath,
      `ramp-review-confirmation-${rampReportId}`,
    );
    const updatedEvidenceRecord = archiveReimbursementEvidence({
      sourcePath: evidenceRecord.archivedPath,
      orderId: evidenceRecord.orderId,
      label: isWalmartEvidence ? "walmart-tip-evidence" : "ramp-reimbursement-evidence",
      metadata: {
        uploadedAt: new Date().toISOString(),
        rampReportId,
        reviewUrl,
        rampConfirmationPath: confirmationScreenshot.archivedPath,
        rampConfirmationSha256: confirmationScreenshot.sha256,
        rampConfirmationImageWidth: confirmationScreenshot.imageWidth,
        rampConfirmationImageHeight: confirmationScreenshot.imageHeight,
      },
    });

    return {
      reviewUrl,
      rampReportId,
      amount: input.amount,
      transactionDate: formatRampTransactionDate(input.transactionDate),
      memo: input.memo,
      evidencePath: updatedEvidenceRecord.archivedPath,
      evidenceSha256: updatedEvidenceRecord.sha256,
      evidenceImageWidth: updatedEvidenceRecord.imageWidth,
      evidenceImageHeight: updatedEvidenceRecord.imageHeight,
      rampConfirmationPath: confirmationScreenshot.archivedPath,
    };
  }

  async replaceRampReimbursementReceipt(input: {
    reviewUrl: string;
    evidencePath: string;
  }): Promise<{
    reviewUrl: string;
    evidencePath: string;
    evidenceSha256: string;
    evidenceImageWidth?: number;
    evidenceImageHeight?: number;
    rampConfirmationPath: string;
  }> {
    const page = this.getPage();
    const evidenceRecord = archiveReimbursementEvidence({
      sourcePath: input.evidencePath,
      label: "walmart-tip-evidence",
      metadata: {
        kind: "walmart_tip_evidence",
      },
    });
    await page.goto(input.reviewUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    }).catch(() => undefined);
    await page.waitForTimeout(2_000);
    await this.assertRampPageAuthenticated(page, "replace the Ramp reimbursement receipt");
    await this.ensureRampReceiptFileInput(page);
    const beforeBody = await page.locator("body").innerText().catch(() => "");
    const beforeAutoVerified = rampReviewBodyLooksAutoVerified(beforeBody);
    const beforeReceiptSubmissionCount = countRampReceiptSubmissionEvents(beforeBody);
    const beforeVisualState = await this.readRampReviewVisualState(page);
    await page.locator('input[type="file"]').first().setInputFiles([evidenceRecord.archivedPath]);
    await page.waitForFunction(
      ({ beforeAutoVerified, beforeReceiptSubmissionCount }) => {
        const text = document.body.innerText || "";
        const normalized = text.replace(/\s+/g, " ").trim();
        const afterAutoVerified = /\bauto-verified\b/i.test(normalized);
        const afterReceiptSubmissionCount =
          (normalized.match(/submitted a receipt via web/gi) || []).length;
        return afterReceiptSubmissionCount > beforeReceiptSubmissionCount
          || (!beforeAutoVerified && afterAutoVerified);
      },
      { beforeAutoVerified, beforeReceiptSubmissionCount },
      { timeout: 60_000 },
    ).catch(() => undefined);
    await page.waitForTimeout(2_000);
    const afterBody = await page.locator("body").innerText().catch(() => "");
    const afterAutoVerified = rampReviewBodyLooksAutoVerified(afterBody);
    const afterReceiptSubmissionCount = countRampReceiptSubmissionEvents(afterBody);
    const afterVisualState = await this.readRampReviewVisualState(page);
    const receiptActivityChanged =
      afterReceiptSubmissionCount > beforeReceiptSubmissionCount
      || (afterAutoVerified && !beforeAutoVerified);
    const receiptPreviewChanged = rampReviewVisualStateChanged(beforeVisualState, afterVisualState);
    const expectsImagePreview = evidencePathLooksImage(evidenceRecord.archivedPath);
    if (
      !receiptActivityChanged
      && !receiptPreviewChanged
    ) {
      throw new Error(
        "Ramp receipt replacement did not show a new receipt-upload activity entry, newly auto-verified state, or changed receipt preview.",
      );
    }
    if (expectsImagePreview && !rampReviewVisualStateLooksReceiptLike(afterVisualState)) {
      throw new Error(
        `Ramp receipt replacement preview is too small to trust (largest receipt image ${afterVisualState.largestReceiptImageWidth}x${afterVisualState.largestReceiptImageHeight}).`,
      );
    }
    const rampReportId = extractRampReimbursementIdFromUrl(page.url()) ?? extractRampReimbursementIdFromUrl(input.reviewUrl);
    const confirmationScreenshot = await this.captureRampConfirmationScreenshot(
      page,
      evidenceRecord.archivedPath,
      `ramp-review-confirmation-${rampReportId ?? "replacement"}`,
    );
    const updatedEvidenceRecord = archiveReimbursementEvidence({
      sourcePath: evidenceRecord.archivedPath,
      orderId: evidenceRecord.orderId,
      label: "walmart-tip-evidence",
      metadata: {
        uploadedAt: new Date().toISOString(),
        rampReportId: rampReportId ?? undefined,
        reviewUrl: page.url(),
        rampConfirmationPath: confirmationScreenshot.archivedPath,
        rampConfirmationSha256: confirmationScreenshot.sha256,
        rampConfirmationImageWidth: confirmationScreenshot.imageWidth,
        rampConfirmationImageHeight: confirmationScreenshot.imageHeight,
      },
    });
    return {
      reviewUrl: page.url(),
      evidencePath: updatedEvidenceRecord.archivedPath,
      evidenceSha256: updatedEvidenceRecord.sha256,
      evidenceImageWidth: updatedEvidenceRecord.imageWidth,
      evidenceImageHeight: updatedEvidenceRecord.imageHeight,
      rampConfirmationPath: confirmationScreenshot.archivedPath,
    };
  }

  /** Disconnect from the browser (does NOT close Chrome). */
  async close(): Promise<string> {
    if (this.browser) {
      try {
        this.browser.removeAllListeners();
        // For CDP connections, close() disconnects without killing the browser
        await this.browser.close();
      } catch {
        /* ignore */
      }
      this.browser = null;
      this.page = null;
    }
    return "Browser disconnected";
  }

  /** Get connection status and current page info. */
  async status(): Promise<{
    connected: boolean;
    url?: string;
    title?: string;
  }> {
    if (!this.page) return { connected: false };
    try {
      return {
        connected: true,
        url: this.page.url(),
        title: await this.page.title(),
      };
    } catch {
      this.page = null;
      return { connected: false };
    }
  }

  private getPage(): Page {
    if (!this.page) {
      throw new Error(
        "No browser connected. Use action 'launch' first, or 'connect' with a " +
          "CDP URL (e.g. http://127.0.0.1:9223).",
      );
    }
    return this.page;
  }
}
