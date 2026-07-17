import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateService } from "../src/state-management.js";
import { TangoStorage } from "../src/storage.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function harness(now = new Date("2026-07-17T12:00:00.000Z")) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-state-"));
  tempDirs.push(dir);
  const storage = new TangoStorage(path.join(dir, "tango.sqlite"));
  const service = new StateService(storage.getDatabase(), { now: () => now });
  const context = {
    actor: "test",
    source: "test-harness",
    sessionId: "session-1",
    turnId: "turn-1",
    agentId: "watson",
    agentType: "personal",
  } as const;
  return { storage, service, context, db: storage.getDatabase() };
}

describe("state management schema and governance", () => {
  it("migrates the complete substrate, seeds only generic types, and grants state tools", () => {
    const { storage, db } = harness();
    expect(Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version)).toBeGreaterThanOrEqual(63);
    expect((db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(5_000);
    for (const table of [
      "state_entity_types", "state_entities", "state_events", "state_focus",
      "state_reconciler_runs", "state_issues", "state_memory_links", "state_adapter_cursors",
    ]) {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)).toBeTruthy();
    }
    expect(db.prepare("SELECT id FROM state_entity_types ORDER BY id").all().map((row) => (row as { id: string }).id)).toEqual([
      "automation-job", "body-composition", "finance-review", "project", "travel", "vehicle",
    ]);
    const stateTools = db.prepare("SELECT id FROM governance_tools WHERE id LIKE 'state_%' ORDER BY id").all().map((row) => (row as { id: string }).id);
    expect(stateTools).toEqual(["state_define_type", "state_query", "state_update"]);
    expect(Number((db.prepare("SELECT COUNT(*) AS count FROM permissions WHERE tool_id='state_query'").get() as { count: number }).count)).toBeGreaterThan(0);
    expect(Number((db.prepare("SELECT COUNT(*) AS count FROM state_entities").get() as { count: number }).count)).toBe(0);
    storage.close();
  });
});

describe("StateService", () => {
  it("validates, transitions, deduplicates, records provenance, and queries deterministically", () => {
    const { storage, service, context } = harness();
    const created = service.mutate({
      typeId: "project",
      title: "Synthetic Launch",
      status: "active",
      attributes: { next_action: "Run the fixture", progress_pct: 10 },
    }, context);
    expect(created.created).toBe(true);
    expect(created.event).toMatchObject({ kind: "create", actor: "test", sessionId: "session-1", turnId: "turn-1" });

    const duplicate = service.mutate({
      typeId: "project",
      title: "Synthetic Launch",
      attributes: { progress_pct: 10 },
    }, { ...context, turnId: "turn-2" });
    expect(duplicate.applied).toBe(false);
    expect(duplicate.reason).toBe("no_change");
    expect(service.query({ text: "synthetic", recentEvents: 5 }).entities).toHaveLength(1);

    expect(() => service.mutate({
      entityId: created.entity.id,
      attributes: { progress_pct: 101 },
    }, { ...context, turnId: "turn-invalid" })).toThrow(/must be <= 100/u);
    expect(() => service.mutate({
      entityId: created.entity.id,
      status: "idea",
    }, { ...context, turnId: "turn-invalid-status" })).toThrow(/Illegal Project transition/u);

    const changed = service.mutate({
      entityId: created.entity.id,
      attributes: { progress_pct: 40 },
      status: "blocked",
    }, { ...context, turnId: "turn-3", messageId: "message-3" });
    expect(changed.entity.attributes.progress_pct).toBe(40);
    expect(changed.entity.status).toBe("blocked");
    expect(changed.event?.messageId).toBe("message-3");
    expect(service.renderTurnReceipt("turn-3")).toContain("progress pct 10 → 40");
    storage.close();
  });

  it("supports observations, trend aggregations, per-event revert, turn undo, and create undo by archive", () => {
    const { storage, service, context } = harness();
    const entity = service.mutate({
      typeId: "body-composition",
      title: "Fixture Metrics",
      attributes: { weight_lb: 180 },
      kind: "observation",
    }, { ...context, agentId: "malibu", agentType: "wellness", occurredAt: "2026-07-15T12:00:00Z" });
    const update = service.mutate({
      entityId: entity.entity.id,
      attributes: { weight_lb: 178, body_fat_pct: 20 },
      kind: "observation",
    }, { ...context, agentId: "malibu", agentType: "wellness", turnId: "turn-metrics", occurredAt: "2026-07-16T12:00:00Z" });
    expect(service.query({
      entityId: entity.entity.id,
      agentId: "malibu",
      agentType: "wellness",
      trend: { field: "weight_lb", windowDays: 30, aggregation: "change" },
    }).trend).toMatchObject({ value: -2 });

    const reverted = service.revertEvent(update.event!.id, {
      ...context,
      agentId: "malibu",
      agentType: "wellness",
      turnId: "turn-revert",
    });
    expect(reverted.entity.attributes).toEqual({ weight_lb: 180 });
    expect(reverted.event?.revertsEventId).toBe(update.event!.id);
    expect(service.revertEvent(update.event!.id, { ...context, agentId: "malibu", agentType: "wellness" }).reason).toBe("already_reverted");

    const project = service.mutate({ typeId: "project", title: "Undo Fixture", status: "active", attributes: {} }, { ...context, turnId: "turn-create" });
    const undo = service.revertTurn("turn-create", { ...context, turnId: "turn-undo" });
    expect(undo.applied).toBe(1);
    expect(service.getEntity(project.entity.id)).toBeNull();
    expect(service.getEntity(project.entity.id, {}, true)?.title).toBe("Undo Fixture");
    storage.close();
  });

  it("enforces private visibility while allowing the wellness scope", () => {
    const { storage, service, context } = harness();
    const created = service.mutate({ typeId: "body-composition", title: "Private Fixture", attributes: { weight_lb: 170 } }, {
      ...context,
      agentId: "malibu-ollama",
      agentType: "wellness",
    });
    expect(service.getEntity(created.entity.id, { agentId: "watson", agentType: "personal" })).toBeNull();
    expect(service.getEntity(created.entity.id, { agentId: "malibu", agentType: "wellness" })).not.toBeNull();
    expect(service.query({ agentId: "watson", agentType: "personal" }).entities).toHaveLength(0);
    storage.close();
  });

  it("builds focus-first bounded digests and expires stale focus", () => {
    let now = new Date("2026-07-17T12:00:00Z");
    const { storage, service, context } = harness(now);
    const first = service.mutate({ typeId: "project", title: "Focused Fixture", status: "active", attributes: { next_action: "Verify digest" } }, context);
    for (let index = 0; index < 20; index += 1) {
      service.mutate({ typeId: "vehicle", title: `Fixture Vehicle ${index}`, attributes: { make: "Test", model: `V${index}` } }, { ...context, turnId: `vehicle-${index}` });
    }
    service.focusEntities("discord:fixture", [first.entity.id], 1);
    const digest = service.buildDigest({ conversationKey: "discord:fixture", alwaysOnTypes: ["vehicle"], tokenBudget: 80, now });
    expect(digest).toContain("state (canonical — overrides anything remembered)");
    expect(digest).toContain("Focused Fixture");
    expect(digest!.length).toBeLessThanOrEqual(80 * 4 + 32);
    now = new Date("2026-07-19T12:00:00Z");
    storage.getDatabase().prepare("UPDATE state_focus SET expires_at = '2026-07-16 00:00:00'").run();
    expect(service.sweep().evaluated).toBe(21);
    expect(Number((storage.getDatabase().prepare("SELECT COUNT(*) AS count FROM state_focus").get() as { count: number }).count)).toBe(0);
    storage.close();
  });

  it("allows confirmed additive type evolution and rejects destructive changes", () => {
    const { storage, service } = harness();
    expect(() => service.defineType({
      id: "fixture", displayName: "Fixture", attributesSchema: { type: "object", properties: {} }, origin: "conversation",
    })).toThrow(/confirm=true/u);
    service.defineType({
      id: "fixture",
      displayName: "Fixture",
      attributesSchema: { type: "object", additionalProperties: false, properties: { label: { type: "string" } } },
      origin: "conversation",
      confirm: true,
    });
    const evolved = service.defineType({
      id: "fixture",
      displayName: "Fixture",
      attributesSchema: { type: "object", additionalProperties: false, properties: { label: { type: "string" }, count: { type: "number" } } },
      origin: "conversation",
      confirm: true,
    });
    expect(evolved.type.attributesSchema).toHaveProperty("properties.count");
    expect(() => service.defineType({
      id: "fixture", displayName: "Fixture", attributesSchema: { type: "object", properties: { count: { type: "number" } } }, origin: "conversation", confirm: true,
    })).toThrow(/cannot be removed/u);
    const normalized = service.defineType({
      id: `${"-".repeat(20_000)}Fixture${"-".repeat(20_000)}Type${"-".repeat(20_000)}`,
      displayName: "Normalized Fixture",
      attributesSchema: { type: "object", properties: {} },
      origin: "conversation",
      confirm: true,
    });
    expect(normalized.type.id).toBe("fixture-type");
    storage.close();
  });

  it("sweeps stale lifecycle policies, issues, cursors, and memory links", () => {
    const { storage, service, context, db } = harness();
    const stale = service.mutate({ typeId: "project", title: "Stale Fixture", status: "active", attributes: {} }, {
      ...context,
      occurredAt: "2026-06-01T00:00:00Z",
    });
    const trip = service.mutate({
      typeId: "travel",
      title: "Completed Trip Fixture",
      status: "completed",
      attributes: { start_date: "2026-07-10", end_date: "2026-07-15" },
    }, { ...context, turnId: "turn-trip", occurredAt: "2026-07-15T12:00:00Z" });
    service.defineType({
      id: "expiring-fixture",
      displayName: "Expiring Fixture",
      attributesSchema: { type: "object", additionalProperties: false, properties: {} },
      statuses: {
        values: ["active", "expired"],
        transitions: { active: ["expired"], expired: ["active"] },
        initial: "active",
      },
      stalenessPolicy: { expected_update_days: 1, on_stale: "expire" },
      origin: "seed",
      confirm: true,
    }, { includePrivate: true });
    const expiring = service.mutate({
      typeId: "expiring-fixture",
      title: "Expiring Entity Fixture",
      status: "active",
      attributes: {},
    }, { ...context, turnId: "turn-expiring", occurredAt: "2026-07-01T00:00:00Z" });
    const report = service.sweep();
    expect(report).toMatchObject({ stale: 3, expired: 1, archived: 1 });
    expect(service.listIssues("open").some((issue) => issue.entityId === stale.entity.id && issue.kind === "stale")).toBe(true);
    expect(service.listIssues("open").some((issue) => issue.kind === "reconciler_stalled")).toBe(true);
    expect(service.getEntity(expiring.entity.id, {}, true)?.status).toBe("expired");
    expect(service.listEvents(expiring.entity.id)[0]).toMatchObject({ kind: "status_change", actor: "sweep" });
    expect(service.getEntity(trip.entity.id, {}, true)?.archivedAt).toBeTruthy();
    expect(service.listEvents(trip.entity.id)[0]).toMatchObject({ kind: "archive", actor: "sweep" });
    service.setAdapterCursor("fixture-adapter", "cursor-1", { count: 1 });
    expect(service.getAdapterCursor("fixture-adapter")).toEqual({ cursor: "cursor-1", metadata: { count: 1 } });
    service.linkMemoryVerdict({ eventId: stale.event!.id, memoryId: "fixture-memory", entityId: stale.entity.id, verdict: "current_truth", archived: true });
    expect(service.getArchivedMemoryIdsForEvents([stale.event!.id])).toEqual(["fixture-memory"]);
    service.markMemoriesUnarchived(["fixture-memory"]);
    expect((db.prepare("SELECT unarchived_at AS value FROM state_memory_links WHERE memory_id='fixture-memory'").get() as { value: string }).value).toBeTruthy();
    storage.close();
  });
});
