import { describe, expect, it } from "vitest";
import { isReadOnlyGogEmailCommand } from "../src/gog-email-access.js";

describe("gog email access classification", () => {
  it("treats Gmail search, message read, and attachment read commands as read-only", () => {
    expect(isReadOnlyGogEmailCommand("gmail messages search \"Opening Hymn\"")).toBe(true);
    expect(isReadOnlyGogEmailCommand("gmail messages list newer_than:7d")).toBe(true);
    expect(isReadOnlyGogEmailCommand("gmail get 198ae0570be212b7")).toBe(true);
    expect(isReadOnlyGogEmailCommand("gmail messages get 198ae0570be212b7")).toBe(true);
    expect(isReadOnlyGogEmailCommand("gmail attachment 198ae0570be212b7 church-publication.pdf")).toBe(true);
    expect(isReadOnlyGogEmailCommand("gmail thread 198ae0570be212b7")).toBe(true);
  });

  it("treats Gmail mutation commands as write operations", () => {
    expect(isReadOnlyGogEmailCommand("gmail thread modify 198ae0570be212b7 --archive")).toBe(false);
    expect(isReadOnlyGogEmailCommand("gmail messages send --to someone@example.com")).toBe(false);
    expect(isReadOnlyGogEmailCommand("gmail draft create --to someone@example.com")).toBe(false);
  });
});
