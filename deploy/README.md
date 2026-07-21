# Deployment (Phase 6 slice)

Rootless Podman + Quadlet, per architecture.md §13. **Phase 6** ships the two units that
make the chat surface reachable; the full stack (`catalog-migrate`, `catalog-ingest` timer,
`reranker`, `otel-collector`) lands in Phase 9.

## The two surfaces (§10.5)

| Surface                 | What it is                                                                                                                                      | Quadlet                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Astro** (`apps/web`)  | The product: cards, editable chips (§10.2), zero-result relaxation (§10.3), freshness (§10.4), feedback.                                        | served static behind an edge that routes `/api/*` → `catalog-api` (Phase 9) |
| **Open WebUI** (compat) | Interop/dogfooding: chat via the OpenAI-compatible `/v1` endpoint. Degrades to a markdown table — no cards — but facts are still live-hydrated. | [`quadlet/open-webui.container`](./quadlet/open-webui.container)            |

Both run the **same** answer agent, so ADR-008 holds on both: the model chooses rows, the
database speaks the facts.

## Open WebUI quadlet

```sh
# rootless install
mkdir -p ~/.config/containers/systemd
cp deploy/quadlet/catalog.network deploy/quadlet/open-webui.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start open-webui        # → http://localhost:8080
```

It expects the API server reachable as `catalog-api:3000` on the `catalog` Podman network
(the `catalog-api` unit is Phase 9; for a laptop demo, run `pnpm dev:server` and set
`OPENAI_API_BASE_URL=http://host.containers.internal:3000/v1` instead).

## The Astro app in dev

```sh
pnpm dev:server                          # API on :3000
pnpm --filter @catalog/web dev           # Astro on :4321, proxies /api/* → :3000
```

`astro.config.mjs` proxies `/api/*` to the API server, so the browser stays same-origin
(no CORS). In production the same path split is done by the edge proxy. Point the proxy at
a non-default API origin with `CATALOG_API_ORIGIN`.
