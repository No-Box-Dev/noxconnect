import { defineConfig } from "vitest/config";

export default defineConfig({
  root: "workers/legacy-bridge",
  test: {
    include: ["src/**/*.test.ts"],
  },
});
