export const WALMART_PAYMENT_SUMMARY_SELECTORS = [
  "div.bill-order-payment-spacing",
  "section:has-text('Driver tip')",
  "div.mv3.mv4-l.ph3-l:has-text('Driver tip')",
  "div.mv2:has-text('Driver tip')",
] as const;

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
