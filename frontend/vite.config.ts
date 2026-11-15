import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies the backend so the app never needs CORS.
// DIGINSIDE_BACKEND_PORT overrides the backend port (default 8000).
declare const process: { env: Record<string, string | undefined> }; // avoids needing @types/node
const backend = `127.0.0.1:${process.env.DIGINSIDE_BACKEND_PORT ?? 8000}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": `http://${backend}`,
      "/run_cache": `http://${backend}`,
      "/ws": { target: `ws://${backend}`, ws: true },
    },
  },
});
