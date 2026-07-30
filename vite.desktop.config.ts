import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "desktop",
  base: "./",
  // The desktop renderer uses the same pet artwork as the web build. Vite's
  // root is `desktop`, so explicitly copy the repository-level public assets
  // into `desktop-dist` for Tauri's custom protocol to serve them.
  publicDir: "../public",
  plugins: [react()],
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "../desktop-dist",
    emptyOutDir: true,
  },
});
