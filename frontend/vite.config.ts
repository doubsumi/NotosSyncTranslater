/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const apiTarget = env.VITE_API_TARGET || "http://127.0.0.1:5000";
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        // In development the SPA talks to the Flask API through Vite.
        "/api": {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: "dist",
      sourcemap: false,
      target: "es2020",
      chunkSizeWarningLimit: 600,
    },
    test: {
      environment: "node",
      include: ["src/**/*.test.{ts,tsx}"],
    },
  };
});
