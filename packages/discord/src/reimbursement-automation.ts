export const WALMART_PAYMENT_SUMMARY_SELECTORS = [
  "div.bill-order-payment-spacing",
  "section:has-text('Driver tip')",
  "div.mv3.mv4-l.ph3-l:has-text('Driver tip')",
  "div.mv2:has-text('Driver tip')",
] as const;

export interface ParsedGogEmailFullOutput {
  headers: Record<string, string>;
  body: string;
  bodyFormat: "html" | "text";
}

const MONTH_INDEX = new Map<string, string>([
  ["jan", "01"],
  ["january", "01"],
  ["feb", "02"],
  ["february", "02"],
  ["mar", "03"],
  ["march", "03"],
  ["apr", "04"],
  ["april", "04"],
  ["may", "05"],
  ["jun", "06"],
  ["june", "06"],
  ["jul", "07"],
  ["july", "07"],
  ["aug", "08"],
  ["august", "08"],
  ["sep", "09"],
  ["sept", "09"],
  ["september", "09"],
  ["oct", "10"],
  ["october", "10"],
  ["nov", "11"],
  ["november", "11"],
  ["dec", "12"],
  ["december", "12"],
]);

export function extractWalmartOrderIdFromUrl(url: string): string | null {
  const match = /\/orders\/([0-9]{7,}-[0-9]{8,})(?:[/?#]|$)/iu.exec(url);
  return match?.[1] ?? null;
}

export function flattenWalmartOrderId(orderId: string): string {
  return orderId.replace(/\D/gu, "");
}

export function normalizeWalmartOrderId(orderId: string): string {
  const trimmed = orderId.trim();
  const directMatch = /^[0-9]{7,}-[0-9]{8,}$/u.exec(trimmed);
  if (directMatch) {
    return directMatch[0];
  }

  const flat = flattenWalmartOrderId(trimmed);
  if (flat.length >= 15) {
    return `${flat.slice(0, 7)}-${flat.slice(7, 15)}`;
  }

  return trimmed;
}

const WALMART_EXPLICIT_DATE_PATTERN =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:,\s*\d{4})?|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/giu;

function normalizeText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

export function parseGogEmailFullOutput(raw: string): ParsedGogEmailFullOutput {
  const normalized = raw.replace(/\r\n/gu, "\n");
  const lines = normalized.split("\n");
  const headers: Record<string, string> = {};
  let bodyStartIndex = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      bodyStartIndex = index + 1;
      break;
    }
    if (/^\s*</u.test(line)) {
      bodyStartIndex = index;
      break;
    }
    const headerMatch = /^([a-z0-9_ -]+)\t(.*)$/iu.exec(line);
    if (!headerMatch) {
      bodyStartIndex = index;
      break;
    }
    headers[headerMatch[1]!.trim().toLowerCase().replace(/\s+/gu, "_")] = headerMatch[2]!.trim();
    bodyStartIndex = index + 1;
  }

  const body = lines.slice(bodyStartIndex).join("\n").trim();
  const bodyFormat = /<(?:!doctype|html|body|table|div|p|span)\b/iu.test(body) ? "html" : "text";
  return { headers, body, bodyFormat };
}

export function buildEmailEvidenceHtml(parsed: ParsedGogEmailFullOutput): string {
  const from = escapeHtml(parsed.headers["from"] ?? "");
  const to = escapeHtml(parsed.headers["to"] ?? "");
  const subject = escapeHtml(parsed.headers["subject"] ?? "");
  const date = escapeHtml(parsed.headers["date"] ?? "");
  const bodyContent =
    parsed.bodyFormat === "html"
      ? parsed.body
      : `<pre>${escapeHtml(parsed.body)}</pre>`;

  return [
    "<!DOCTYPE html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\" />",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
    "<title>Email Receipt Evidence</title>",
    "<style>",
    "body { margin: 0; padding: 32px; background: #f3f5f8; color: #111827; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }",
    ".frame { max-width: 1024px; margin: 0 auto; background: #ffffff; border: 1px solid #d0d7de; border-radius: 18px; overflow: hidden; box-shadow: 0 18px 40px rgba(15, 23, 42, 0.08); }",
    ".meta { padding: 24px 28px; border-bottom: 1px solid #e5e7eb; background: #fbfbfc; }",
    ".meta h1 { margin: 0 0 18px; font-size: 28px; line-height: 1.2; }",
    ".grid { display: grid; grid-template-columns: 120px 1fr; gap: 8px 14px; font-size: 15px; line-height: 1.45; }",
    ".label { color: #6b7280; font-weight: 600; }",
    ".value { color: #111827; word-break: break-word; }",
    ".body { padding: 24px 28px; }",
    ".body pre { white-space: pre-wrap; word-break: break-word; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; }",
    ".body img { max-width: 100%; height: auto; }",
    "</style>",
    "</head>",
    "<body>",
    "<div class=\"frame\">",
    "<section class=\"meta\">",
    `<h1>${subject || "Email receipt evidence"}</h1>`,
    "<div class=\"grid\">",
    `<div class=\"label\">From</div><div class=\"value\">${from}</div>`,
    `<div class=\"label\">To</div><div class=\"value\">${to}</div>`,
    `<div class=\"label\">Date</div><div class=\"value\">${date}</div>`,
    "</div>",
    "</section>",
    `<section class=\"body\">${bodyContent}</section>`,
    "</div>",
    "</body>",
    "</html>",
  ].join("");
}

export function extractWalmartExplicitDates(text: string): string[] {
  const normalized = normalizeText(text);
  const matches = normalized.match(WALMART_EXPLICIT_DATE_PATTERN) ?? [];
  return [...new Set(matches.map((value) => value.trim()))];
}

export function walmartTextLooksDateVerifiable(text: string): boolean {
  return extractWalmartExplicitDates(text).length > 0;
}

export function rampReviewBodyLooksAutoVerified(text: string): boolean {
  return /\bauto-verified\b/iu.test(normalizeText(text));
}

export function rampReimbursementLooksSubmitted(text: string): boolean {
  const normalized = normalizeText(text);
  return (
    /\brequested a reimbursement\b/iu.test(normalized)
    || /\bsubmitted\s+\$[\d,.]+\s+reimbursement\b/iu.test(normalized)
    || /\bsubmitted on\s+\d{2}\/\d{2}\/\d{4}\b/iu.test(normalized)
    || /\bapprove reimbursement\b/iu.test(normalized)
    || /\bawaiting reviewer\b/iu.test(normalized)
  );
}

export function rampPageLooksSignedOut(input: {
  url?: string | null;
  title?: string | null;
  text?: string | null;
}): boolean {
  const url = input.url?.trim() ?? "";
  const title = normalizeText(input.title ?? "");
  const text = normalizeText(input.text ?? "");
  if (/\/sign-in(?:[/?#]|$)/iu.test(url)) {
    return true;
  }
  if (/\bsign in\b/iu.test(title)) {
    return true;
  }
  if (
    /\bwelcome back\b/iu.test(text)
    && /\bemail address\b/iu.test(text)
  ) {
    return true;
  }
  return false;
}

export function countRampReceiptSubmissionEvents(text: string): number {
  return (normalizeText(text).match(/submitted a receipt via web/giu) ?? []).length;
}

export interface RampReviewImageSignal {
  src: string;
  alt: string;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
}

export interface RampReviewVisualState {
  receiptImageCount: number;
  largestReceiptImageWidth: number;
  largestReceiptImageHeight: number;
  previewSignature: string[];
}

function normalizeRampPreviewSrc(src: string): string {
  return src.replace(/[?#].*$/u, "").trim();
}

export function buildRampReviewVisualState(images: readonly RampReviewImageSignal[]): RampReviewVisualState {
  const receiptImages = images
    .filter((image) => {
      const maxWidth = Math.max(image.width, image.naturalWidth);
      const maxHeight = Math.max(image.height, image.naturalHeight);
      return maxWidth >= 120 || maxHeight >= 120 || /\breceipt\b/iu.test(image.alt);
    })
    .sort((left, right) => {
      const leftArea = Math.max(left.width, left.naturalWidth) * Math.max(left.height, left.naturalHeight);
      const rightArea = Math.max(right.width, right.naturalWidth) * Math.max(right.height, right.naturalHeight);
      return rightArea - leftArea;
    });

  return {
    receiptImageCount: receiptImages.length,
    largestReceiptImageWidth: receiptImages.reduce(
      (best, image) => Math.max(best, image.naturalWidth, image.width),
      0,
    ),
    largestReceiptImageHeight: receiptImages.reduce(
      (best, image) => Math.max(best, image.naturalHeight, image.height),
      0,
    ),
    previewSignature: receiptImages
      .slice(0, 6)
      .map((image) =>
        `${normalizeRampPreviewSrc(image.src)}#${Math.max(image.naturalWidth, image.width)}x${Math.max(image.naturalHeight, image.height)}`,
      ),
  };
}

export function rampReviewVisualStateChanged(
  before: RampReviewVisualState,
  after: RampReviewVisualState,
): boolean {
  if (after.receiptImageCount !== before.receiptImageCount) {
    return true;
  }
  if (after.largestReceiptImageWidth !== before.largestReceiptImageWidth) {
    return true;
  }
  if (after.largestReceiptImageHeight !== before.largestReceiptImageHeight) {
    return true;
  }
  if (after.previewSignature.length !== before.previewSignature.length) {
    return true;
  }
  return after.previewSignature.some((value, index) => value !== before.previewSignature[index]);
}

export function rampReviewVisualStateLooksReceiptLike(state: RampReviewVisualState): boolean {
  return state.largestReceiptImageWidth >= 200 && state.largestReceiptImageHeight >= 200;
}

export function parseFlexibleDateToIso(input: string): string | null {
  const trimmed = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/u.test(trimmed)) {
    return trimmed;
  }

  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(trimmed);
  if (slashMatch) {
    const [, month, day, year] = slashMatch;
    return `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
  }

  const monthMatch =
    /^([A-Za-z]+)\.?\s+(\d{1,2})(?:,\s*(\d{4}))?$/u.exec(trimmed);
  if (monthMatch) {
    const [, rawMonth, rawDay, rawYear] = monthMatch;
    if (!rawYear) {
      return null;
    }
    const month = MONTH_INDEX.get(rawMonth!.toLowerCase());
    if (!month) {
      return null;
    }
    return `${rawYear}-${month}-${rawDay!.padStart(2, "0")}`;
  }

  return null;
}

export function formatRampTransactionDate(input: string): string {
  const trimmed = input.trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(trimmed)) return trimmed;

  const isoDate = parseFlexibleDateToIso(trimmed);
  const match = isoDate ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate) : null;
  if (!match) {
    throw new Error(
      `Unsupported Ramp transaction date format: ${input}. Use YYYY-MM-DD, MM/DD/YYYY, or 'Mon DD, YYYY'.`,
    );
  }

  const [, year, month, day] = match;
  return `${month}/${day}/${year}`;
}

export function extractRampReimbursementIdFromUrl(url: string): string | null {
  const match =
    /\/details\/(?:list\/reimbursement|reimbursements)\/([0-9a-f-]+)\/(?:draft|review)/i.exec(
      url,
    );
  return match?.[1] ?? null;
}

export function buildRampReviewUrl(id: string): string {
  return `https://app.ramp.com/details/reimbursements/${id}/review`;
}
