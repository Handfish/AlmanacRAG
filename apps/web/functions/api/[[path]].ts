// Edge proxy: /api/* → the Cloud Run API. This is the production half of the path
// split described in architecture.md §10.5 ("an edge that routes /api/* → catalog-api")
// and README (deploy/). It mirrors the dev-only Vite proxy in astro.config.mjs, which
// strips the /api prefix so the server sees /chat, /search, /relax, /hydrate, /feedback.
//
// The [[path]] catch-all binds everything after /api/ to params.path, so dropping the
// /api prefix is automatic: /api/chat → target /chat.
//
// CATALOG_API_ORIGIN is a Pages environment variable set to the Cloud Run service URL
// (wired by CI from the Terraform output — see .github/workflows/deploy.yml).
//
// SSE (/chat streams tokens, http/chat.ts) passes through untouched because we return
// the upstream Response object verbatim — Pages Functions stream the body as it arrives.

// Deliberately untyped context (no @cloudflare/workers-types dependency) so `astro check`
// over the web package stays happy; the Cloudflare runtime supplies these at call time.
export const onRequest = async (
  context: {
    request: Request;
    env: { CATALOG_API_ORIGIN?: string };
    params: { path?: string | ReadonlyArray<string> };
  },
): Promise<Response> => {
  const { request, env, params } = context;

  const origin = env.CATALOG_API_ORIGIN;
  if (!origin) {
    return new Response("CATALOG_API_ORIGIN is not configured on the Pages project", {
      status: 500,
    });
  }

  const incoming = new URL(request.url);
  const rest = Array.isArray(params.path) ? params.path.join("/") : (params.path ?? "");
  const target = new URL(`/${rest}${incoming.search}`, origin);

  // Forward method, headers, and body as-is. The Host header is managed by the runtime,
  // so we do not set it. Returning the fetch Response directly preserves streaming.
  return fetch(new Request(target, request));
};
