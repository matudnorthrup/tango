/**
 * Printer Monitor — deterministic scheduler handler.
 *
 * Polls the Prusa MK4 REST API every 2 minutes, tracks state transitions,
 * and returns a notification message when the state changes. Silent when
 * nothing has changed.
 */

import type { DeterministicHandler } from "@tango/core";

const FETCH_TIMEOUT_MS = 5000;

function resolvePrinterStatusUrl(): string | null {
  const configured = process.env.TANGO_PRINTER_STATUS_URL?.trim();
  return configured && configured.length > 0 ? configured : null;
}

function resolvePrinterApiKey(): string | null {
  const configured = process.env.TANGO_PRINTER_API_KEY?.trim();
  return configured && configured.length > 0 ? configured : null;
}

function resolvePrinterLabel(): string {
  const configuredUrl = resolvePrinterStatusUrl();
  if (!configuredUrl) {
    return "configured printer";
  }

  try {
    return new URL(configuredUrl).host || "configured printer";
  } catch {
    return configuredUrl;
  }
}

// In-process state — survives across scheduler ticks, resets on restart.
let lastObservedState = "UNKNOWN";
let lastAlertedState: string | null = null;

interface PrinterStatus {
  printer?: { state?: string };
  job?: { time_remaining?: number; file?: string; display_name?: string };
}

async function fetchPrinterStatusFromApi(): Promise<PrinterStatus | null> {
  const printerUrl = resolvePrinterStatusUrl();
  const apiKey = resolvePrinterApiKey();
  if (!printerUrl || !apiKey) {
    return null;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(printerUrl, {
      headers: { "X-Api-Key": apiKey },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as PrinterStatus;
  } catch {
    return null;
  }
}

let fetchPrinterStatusImpl: () => Promise<PrinterStatus | null> = fetchPrinterStatusFromApi;

function isAlertState(state: string): boolean {
  return state === "FINISHING"
    || state === "FINISHED"
    || state === "ATTENTION"
    || state === "ERROR"
    || state === "STOPPED";
}

export function resetPrinterMonitorStateForTests(): void {
  lastObservedState = "UNKNOWN";
  lastAlertedState = null;
  fetchPrinterStatusImpl = fetchPrinterStatusFromApi;
}

export function setPrinterStatusFetcherForTests(
  fetcher: () => Promise<PrinterStatus | null>,
): void {
  fetchPrinterStatusImpl = fetcher;
}

export const printerMonitorHandler: DeterministicHandler = async (_ctx) => {
  const status = await fetchPrinterStatusImpl();

  if (!status) {
    if (lastObservedState !== "UNREACHABLE") {
      lastObservedState = "UNREACHABLE";
      return {
        status: "ok",
        summary: `⚠️ Printer unreachable — could not connect to ${resolvePrinterLabel()}`,
      };
    }
    return { status: "skipped", summary: "Printer still unreachable" };
  }

  const state = status.printer?.state ?? "UNKNOWN";
  const timeRemaining = status.job?.time_remaining;
  const jobName = status.job?.file ?? status.job?.display_name;

  let currentKey = state;
  if (state === "PRINTING" && typeof timeRemaining === "number" && timeRemaining <= 300) {
    currentKey = "FINISHING";
  }

  if (currentKey === lastObservedState) {
    return { status: "skipped", summary: `No change (${currentKey})` };
  }

  const previousState = lastObservedState;
  lastObservedState = currentKey;

  // Only re-arm notifications when a genuinely new print starts (PRINTING).
  // IDLE does NOT reset — the Prusa API can oscillate between FINISHED and
  // IDLE (display menu, auto-idle timer), which would cause duplicate
  // "print complete" notifications for the same print.
  if (currentKey === "PRINTING") {
    lastAlertedState = null;
  }

  // First poll after startup — just learn the current state, don't notify
  if (previousState === "UNKNOWN") {
    if (isAlertState(currentKey)) {
      lastAlertedState = currentKey;
    }
    return { status: "skipped", summary: `Initial state: ${currentKey}` };
  }

  // Only notify on interesting transitions
  let message: string | undefined;
  switch (currentKey) {
    case "FINISHING": {
      const mins = Math.round((timeRemaining ?? 0) / 60);
      message = `🖨️ Print finishing in ~${mins} minutes!${jobName ? ` (${jobName})` : ""}`;
      break;
    }
    case "FINISHED":
      message = `✅ Print complete!${jobName ? ` (${jobName})` : ""} — bed is ready to clear.`;
      break;
    case "ATTENTION":
    case "ERROR":
      message = `🚨 Printer needs attention! State: ${state}.${jobName ? ` Job: ${jobName}` : ""}`;
      break;
    case "STOPPED":
      message = `⏹️ Print stopped.${jobName ? ` (${jobName})` : ""}`;
      break;
    case "IDLE":
    case "PRINTING":
      // Silent transitions
      break;
    default:
      message = `❓ Unknown printer state: ${state}`;
      break;
  }

  if (!message) {
    return { status: "ok", summary: `State changed: ${previousState} -> ${currentKey} (silent)` };
  }

  if (currentKey === lastAlertedState) {
    return {
      status: "skipped",
      summary: `State changed: ${previousState} -> ${currentKey} (already notified)`,
    };
  }

  lastAlertedState = currentKey;
  return { status: "ok", summary: message };
};
