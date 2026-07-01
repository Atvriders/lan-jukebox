import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": "http://localhost:3018",
      // Streamed track audio served by the backend.
      "/audio": "http://localhost:3018",
      // rewriteWsOrigin makes Vite rewrite the upgrade's Origin header to the target
      // origin before forwarding, so the backend's isAllowedOrigin check (which defaults
      // to PUBLIC_BASE_URL) doesn't 403 every dev WS upgrade from http://localhost:5173.
      "/ws": { target: "ws://localhost:3018", ws: true, rewriteWsOrigin: true },
    },
  },
});
