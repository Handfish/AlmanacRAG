import { defineConfig } from "astro/config";

// The primary product surface (architecture.md §10.5) — Astro, lean vanilla-TS islands.
// It imports the domain contracts (`Card`/`ListingFilter`/`ObservationWindow`) for
// type-safe rendering and calls the Effect server's JSON endpoints. In dev, `/api/*` is
// proxied to the API server (default :3000) so the browser talks same-origin (no CORS).
// Point CATALOG_API_ORIGIN elsewhere to proxy a non-default server.
const apiOrigin = process.env.CATALOG_API_ORIGIN ?? "http://localhost:3000";

export default defineConfig({
  server: { port: 4321 },
  vite: {
    server: {
      proxy: {
        "/api": {
          target: apiOrigin,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
      },
    },
  },
});
