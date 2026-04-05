import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TangoStorage } from "../src/storage.js";
import { SchedulerStore } from "../src/scheduler/store.js";

const cleanups: Array<{ dir: string; storage: TangoStorage }> = [];

function createStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-scheduler-store-"));
  const storage = new TangoStorage(path.join(dir, "tango.sqlite"));
  const store = new SchedulerStore(storage.getDatabase());
  cleanups.push({ dir, storage });
  return { dir, storage, store };
}

afterEach(() => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    cleanup?.storage.close();
    if (cleanup?.dir) {
      fs.rmSync(cleanup.dir, { recursive: true, force: true });
    }
  }
});

describe("SchedulerStore timestamp persistence", () => {
  it("stores schedule run timestamps as explicit UTC ISO-8601 values", () => {
    const { store, storage } = createStore();

    const runId = store.insertRun({
      scheduleId: "weekly-finance-review",
      executionMode: "agent",
      workerId: "personal-assistant",
    });
    store.updateRunFinished(runId, {
      status: "ok",
      durationMs: 1234,
      summary: "done",
    });

    const row = storage
      .getDatabase()
      .prepare("SELECT started_at, finished_at FROM schedule_runs WHERE id = ?")
      .get(runId) as { started_at: string; finished_at: string };

    expect(row.started_at).toMatch(/T/);
    expect(row.started_at).toMatch(/Z$/);
    expect(row.finished_at).toMatch(/T/);
    expect(row.finished_at).toMatch(/Z$/);
  });

  it("stores schedule completion timestamps as explicit UTC ISO-8601 values", () => {
    const { store, storage } = createStore();

    store.markCompletion({
      workflowId: "weekly-finance-review",
      scope: "daily",
      completedBy: "schedule:weekly-finance-review",
    });

    const row = storage
      .getDatabase()
      .prepare("SELECT completed_at FROM schedule_completions WHERE workflow_id = ?")
      .get("weekly-finance-review") as { completed_at: string };

    expect(row.completed_at).toMatch(/T/);
    expect(row.completed_at).toMatch(/Z$/);
  });
});
