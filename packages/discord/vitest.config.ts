import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@tango/atlas-memory": path.resolve(__dirname, "../atlas-memory/src/index.ts"),
      "@tango/core": path.resolve(__dirname, "../core/src/index.ts"),
      "@tango/voice": path.resolve(__dirname, "../voice/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
