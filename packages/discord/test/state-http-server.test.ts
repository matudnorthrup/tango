import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateService, TangoStorage } from "@tango/core";
import { afterEach, describe, expect, it } from "vitest";
import { createStateHttpServer } from "../src/state-http-server.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("state dashboard HTTP API", () => {
  it("serves the dashboard and routes validated entity/tool writes through the state service", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-state-http-"));
    dirs.push(dir);
    const storage = new TangoStorage(path.join(dir, "tango.sqlite"));
    const service = new StateService(storage.getDatabase());
    const server = createStateHttpServer({ service, port: 0 });
    await server.start();
    try {
      const health = await fetch(`${server.url}/api/health`).then((response) => response.json()) as { status: string };
      expect(health.status).toBe("ok");
      const html = await fetch(`${server.url}/tango-state/`).then((response) => response.text());
      expect(html).toContain("Tango State");

      const emptyProjectQuery = await fetch(`${server.url}/api/tools/state_query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: { type: "project" }, context: { agent_id: "watson" } }),
      }).then((response) => response.json()) as { entities: unknown[]; typeDefinition: { id: string; attributesSchema: { properties: Record<string, unknown> } } };
      expect(emptyProjectQuery.entities).toEqual([]);
      expect(emptyProjectQuery.typeDefinition.id).toBe("project");
      expect(emptyProjectQuery.typeDefinition.attributesSchema.properties).toHaveProperty("progress_pct");

      const toolCreated = await fetch(`${server.url}/api/tools/state_update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { mode: "upsert", entity_id: "project:predicted", type_id: "project", title: "Predicted Fixture", status: "active", attributes: { progress_pct: 3 } },
          context: { agent_id: "watson", turn_id: "tool-turn" },
        }),
      }).then((response) => response.json()) as { created: boolean; entity: { id: string } };
      expect(toolCreated).toMatchObject({ created: true, entity: { id: "project:predicted-fixture" } });

      const created = await fetch(`${server.url}/api/entities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type_id: "project", title: "HTTP Fixture", status: "active", attributes: { progress_pct: 5 } }),
      }).then((response) => response.json()) as { entity: { id: string }; event: { actor: string } };
      expect(created.event.actor).toBe("dashboard");

      const queried = await fetch(`${server.url}/api/tools/state_query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: { entity_id: created.entity.id }, context: { agent_id: "watson" } }),
      }).then((response) => response.json()) as { entities: Array<{ title: string }> };
      expect(queried.entities[0]?.title).toBe("HTTP Fixture");

      const archived = await fetch(`${server.url}/api/entities/${encodeURIComponent(created.entity.id)}/archive`, { method: "POST" }).then((response) => response.json()) as { entity: { archivedAt: string } };
      expect(archived.entity.archivedAt).toBeTruthy();
    } finally {
      await server.stop();
      storage.close();
    }
  });
});
