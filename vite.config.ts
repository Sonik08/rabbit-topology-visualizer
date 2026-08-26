/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "test/**/*.test.ts", "test/**/*.test.tsx"],
    reporters: ["default"],
    environmentMatchGlobs: [
      // React component tests need a DOM. Everything else stays on the
      // faster node env by default.
      ["test/ui/**/*.test.tsx", "jsdom"],
    ],
  },
});
