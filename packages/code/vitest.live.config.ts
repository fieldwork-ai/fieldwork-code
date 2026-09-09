import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["tests/tui.live.ts"], testTimeout: 120_000 } });
