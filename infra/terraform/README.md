# Infrastructure (Terraform)

Free-tier hosting for the catalog RAG stack, as three managed services:

| Piece                          | Service              | What Terraform creates                                                              |
| ------------------------------ | -------------------- | ----------------------------------------------------------------------------------- |
| Postgres + pgvector            | **Neon**             | project (pg16), pooled + direct connection URIs                                     |
| API server (`packages/server`) | **Google Cloud Run** | service, runtime SA, Artifact Registry repo, Secret Manager secrets, public invoker |
| Astro web (`apps/web`)         | **Cloudflare Pages** | Pages project + the `CATALOG_API_ORIGIN` env var the `/api` proxy reads             |

The path split (browser → Pages → `/api/*` proxied to Cloud Run → Neon) is the production
form of `architecture.md` §10.5. The proxy itself is a Pages Function at
`apps/web/functions/api/[[path]].ts`; the container is the repo-root `Dockerfile`.

## What's free, and the caveats

- **Cloudflare Pages** — static hosting, effectively free.
- **Neon** — 0.5 GB storage (the vector set is a couple of MB); compute pinned to 0.25 CU
  and **scale-to-zero after 5 min idle** → ~500 ms cold wake on the first request.
- **Cloud Run** — `min_instance_count = 0` (scale to zero) + `cpu_idle = true`
  (request-based billing). Cold starts on first hit; set `min_instance_count = 1` to
  eliminate them, but that leaves an instance always on and **is no longer free**.
- The real variable cost is **Gemini API usage** (the answerer/router/embedder), not hosting.

## Prerequisites

- Terraform ≥ 1.6, `gcloud`, and Docker.
- A GCP project (billing enabled — required for Cloud Run/Artifact Registry even on free tier).
- A Neon account + API key, a Cloudflare account + API token (Pages\:Edit) and account id.
- A Gemini API key.

## One-time apply

```sh
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # fill in ids + secrets
terraform init
terraform apply
```

On first apply the Cloud Run service starts on a **placeholder image**
(`cloudrun/container/hello`) so it can be created before any build exists. CI then pushes
the real server image; Terraform ignores image drift (`lifecycle.ignore_changes`) so the
two never fight. State is **local** and gitignored — it contains the Neon/Gemini secrets in
plaintext, so keep it off shared storage. To go remote later, add a `backend "gcs"` block in
`versions.tf` and `terraform init -migrate-state`.

Grab what CI needs:

```sh
terraform output cloud_run_url        # public API URL (also wired into Pages)
terraform output pages_url            # https://<project>.pages.dev
```

## CI (GitHub Actions)

`.github/workflows/deploy.yml` runs on push to `main`. It does **not** run Terraform — it
assumes the infra exists and only ships app revisions:

- **api** — build & push the image to Artifact Registry, run Neon migrations against the
  **direct** URL (pulled from Secret Manager, never stored in GitHub), then
  `gcloud run deploy --image` (env/secrets/SA set by Terraform are preserved).
- **web** — `pnpm build:web` then `wrangler pages deploy` (Direct Upload); `./functions`
  ships the `/api` proxy automatically.

Set these repo secrets: `GCP_PROJECT_ID`, `GCP_SA_KEY`, `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`. Keep the `PROJECT_NAME` / `GCP_REGION` env in the workflow in sync
with the Terraform vars of the same name.

The **deployer** service account (`GCP_SA_KEY`) needs: `roles/run.admin`,
`roles/artifactregistry.writer`, `roles/secretmanager.secretAccessor`, and
`roles/iam.serviceAccountUser` on the runtime SA (`<project_name>-run@…`) so it can deploy a
revision that runs as that SA. Prefer **Workload Identity Federation** (the workflow already
requests `id-token: write`) over a long-lived JSON key.

## Gotchas

- **`allUsers` invoker** — the public-access grant fails if an org policy enforces
  domain-restricted sharing (`iam.allowedPolicyMemberDomains`). Either exempt the project or
  drop `google_cloud_run_v2_service_iam_member.public` and front the API differently.
- **SSL** — Neon requires TLS; its connection URIs carry `?sslmode=require`, which node-pg
  (via `@effect/sql-pg`, passed as `connectionString`) honors. No app change needed.
- **Regions** — keep `neon_region_id` near `gcp_region` (defaults: Neon `aws-us-east-2`,
  GCP `us-east1`) to minimize Cloud Run → DB latency.
- **First request after idle** is slow (Neon + Cloud Run both waking). Expected on free tier.
- **Seeding** — Terraform provisions empty Postgres. Run the ingest pipeline
  (`pnpm seed`, or the individual crawl/extract/index steps) against the Neon direct URL to
  populate the corpus before the app is useful.

```
```
