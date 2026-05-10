/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/setupTests.ts"],
    coverage: {
      provider: "v8",
      include: ["server.ts", "src/components/**/*.{ts,tsx}", "src/services/**/*.{ts,tsx}"],
      exclude: ["src/main.tsx", "src/App.tsx"],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      }
    },
  },
  server: {
    port: 5174,
    host: "0.0.0.0",
    watch: {
      usePolling: true,
    },
    proxy: {
      "/socket.io": {
        target: "http://localhost:3000",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
