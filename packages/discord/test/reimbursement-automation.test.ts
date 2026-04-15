import { describe, expect, it } from "vitest";
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
  rampReviewBodyLooksAutoVerified,
  rampReviewVisualStateChanged,
  rampReviewVisualStateLooksReceiptLike,
  walmartTextLooksDateVerifiable,
} from "../src/reimbursement-automation.js";

describe("reimbursement-automation helpers", () => {
  it("formats ISO dates for Ramp", () => {
    expect(formatRampTransactionDate("2026-03-08")).toBe("03/08/2026");
    expect(formatRampTransactionDate("03/08/2026")).toBe("03/08/2026");
    expect(formatRampTransactionDate("Mar 08, 2026")).toBe("03/08/2026");
  });

  it("extracts reimbursement ids from draft and review urls", () => {
    expect(
      extractRampReimbursementIdFromUrl(
        "https://app.ramp.com/details/reimbursements/a3c34db7-b925-452f-aa1b-8641fe9d3e0f/draft",
      ),
    ).toBe("a3c34db7-b925-452f-aa1b-8641fe9d3e0f");
    expect(
      extractRampReimbursementIdFromUrl(
        "https://app.ramp.com/details/list/reimbursement/6bd4a150-a102-4118-8628-a8f3ec7ff7af/review",
      ),
    ).toBe("6bd4a150-a102-4118-8628-a8f3ec7ff7af");
  });

  it("extracts and flattens Walmart order ids from order urls", () => {
    expect(
      extractWalmartOrderIdFromUrl(
        "https://www.walmart.com/orders/2000145-26621876?groupId=abc",
      ),
    ).toBe("2000145-26621876");
    expect(flattenWalmartOrderId("2000145-26621876")).toBe("200014526621876");
    expect(normalizeWalmartOrderId("200014526621876")).toBe("2000145-26621876");
  });

  it("parses flexible Walmart-visible dates into ISO", () => {
    expect(parseFlexibleDateToIso("2025-10-16")).toBe("2025-10-16");
    expect(parseFlexibleDateToIso("10/16/2025")).toBe("2025-10-16");
    expect(parseFlexibleDateToIso("Oct 16, 2025")).toBe("2025-10-16");
    expect(parseFlexibleDateToIso("Oct 16")).toBeNull();
  });

  it("builds a canonical review url", () => {
    expect(buildRampReviewUrl("abc-123")).toBe(
      "https://app.ramp.com/details/reimbursements/abc-123/review",
    );
  });

  it("detects Walmart receipt text that includes date context", () => {
    expect(
      walmartTextLooksDateVerifiable(
        "Delivery from store. Delivered on Mar 20. Driver tip: $35.23.",
      ),
    ).toBe(true);
    expect(
      walmartTextLooksDateVerifiable(
        "Order #2000142-13122385 placed on 2026-03-20 with Driver tip $35.23.",
      ),
    ).toBe(true);
    expect(
      walmartTextLooksDateVerifiable(
        "Items (60) Savings $5.77 Driver tip $27.38 Total $213.66",
      ),
    ).toBe(false);
    expect(
      walmartTextLooksDateVerifiable(
        "Order #2000142-13122385 delivered with Driver tip $35.23.",
      ),
    ).toBe(false);
  });

  it("extracts explicit Walmart-visible dates without treating generic status text as a date", () => {
    expect(
      extractWalmartExplicitDates(
        "Mar 20 Delivered on Mar 20. Driver tip $35.23. Arrives today.",
      ),
    ).toEqual(["Mar 20"]);
    expect(
      extractWalmartExplicitDates(
        "Order #2000142-13122385 placed on 2026-03-20 and updated on 03/21/2026.",
      ),
    ).toEqual(["2026-03-20", "03/21/2026"]);
    expect(
      extractWalmartExplicitDates(
        "Order #2000142-13122385 delivered with Driver tip $35.23.",
      ),
    ).toEqual([]);
  });

  it("detects Ramp auto-verification and receipt submission activity", () => {
    const body = [
      "$36.24 at Walmart",
      "Receipt",
      "Auto-verified",
      "User Example · 3h ago",
      "Submitted a receipt via web",
      "User Example · 7h ago",
      "Submitted a receipt via web",
    ].join("\n");

    expect(rampReviewBodyLooksAutoVerified(body)).toBe(true);
    expect(countRampReceiptSubmissionEvents(body)).toBe(2);
  });

  it("detects signed-out Ramp pages distinctly from authenticated review pages", () => {
    expect(
      rampPageLooksSignedOut({
        url: "https://app.ramp.com/sign-in",
        title: "Sign in — Ramp",
        text: "Welcome back! Email address Continue",
      }),
    ).toBe(true);

    expect(
      rampPageLooksSignedOut({
        url: "https://app.ramp.com/details/reimbursements/abc/review",
        title: "Ramp — Reimbursement",
        text: "$23.91 at Walmart Receipt Auto-verified Submitted a receipt via web",
      }),
    ).toBe(false);
  });

  it("detects submitted Ramp reimbursement detail pages", () => {
    const submittedBody = [
      "$350.00 at Maid in Newport",
      "Memo",
      "executive buyback time",
      "Approve reimbursement",
      "Requested a reimbursement",
      "Submitted $350.00 reimbursement",
      "Auto-verified · Submitted on 04/07/2026 by Devin",
    ].join("\n");
    const draftBody = [
      "$600.00 at Kip Everitt",
      "Memo (required)",
      "Saved",
      "Submit",
    ].join("\n");

    expect(rampReimbursementLooksSubmitted(submittedBody)).toBe(true);
    expect(rampReimbursementLooksSubmitted(draftBody)).toBe(false);
  });

  it("tracks meaningful Ramp receipt preview changes", () => {
    const before = buildRampReviewVisualState([
      {
        src: "https://cdn.ramp.com/receipt-old.png?sig=1",
        alt: "Receipt preview",
        width: 160,
        height: 120,
        naturalWidth: 160,
        naturalHeight: 120,
      },
    ]);
    const after = buildRampReviewVisualState([
      {
        src: "https://cdn.ramp.com/receipt-new.png?sig=2",
        alt: "Receipt preview",
        width: 935,
        height: 904,
        naturalWidth: 935,
        naturalHeight: 904,
      },
    ]);

    expect(rampReviewVisualStateChanged(before, after)).toBe(true);
    expect(rampReviewVisualStateLooksReceiptLike(after)).toBe(true);
    expect(rampReviewVisualStateLooksReceiptLike(before)).toBe(false);
  });

  it("parses raw gog email output and renders receipt-style evidence html", () => {
    const raw = [
      "id\tabc123",
      "from\tVenmo <venmo@venmo.com>",
      "to\tmatu.dnorthrup@gmail.com",
      "subject\tYou paid Kip Everitt $600.00",
      "date\tSat, 4 Apr 2026 17:20:29 +0000",
      "",
      "<!DOCTYPE html><html><body><h1>You paid Kip Everitt</h1><p>$600.00</p><p>Date</p><p>Apr 04, 2026</p></body></html>",
    ].join("\n");

    const parsed = parseGogEmailFullOutput(raw);
    expect(parsed.headers["subject"]).toBe("You paid Kip Everitt $600.00");
    expect(parsed.bodyFormat).toBe("html");
    expect(parsed.body).toContain("$600.00");

    const rendered = buildEmailEvidenceHtml(parsed);
    expect(rendered).toContain("You paid Kip Everitt $600.00");
    expect(rendered).toContain("Venmo receipt");
    expect(rendered).toContain("Recipient");
    expect(rendered).toContain("Kip Everitt");
    expect(rendered).toContain("Venmo &lt;venmo@venmo.com&gt;");
    expect(rendered).toContain("$600.00");
  });
});
