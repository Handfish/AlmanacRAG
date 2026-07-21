# Cloudflare Pages project — the static Astro surface. Only the project shell is managed
# here (no `source` block = no git integration); CI ships builds via `wrangler pages deploy`
# (Direct Upload). The one thing Terraform owns beyond the shell is CATALOG_API_ORIGIN: the
# Pages Function (apps/web/functions/api/[[path]].ts) reads it to proxy /api/* → Cloud Run.
resource "cloudflare_pages_project" "web" {
  account_id        = var.cloudflare_account_id
  name              = var.cf_pages_project_name
  production_branch = "main"

  # The Pages API requires `fail_open` to be set identically for production and preview
  # (error 8000066), so both environments are declared. Both point the /api proxy at the
  # same Cloud Run origin — preview deploys hit the same live API.
  deployment_configs = {
    production = {
      fail_open = true
      # v5 shape: each env var is an object { type, value } (not a bare string).
      env_vars = {
        CATALOG_API_ORIGIN = {
          type  = "plain_text"
          value = google_cloud_run_v2_service.api.uri
        }
      }
    }
    preview = {
      fail_open = true
      env_vars = {
        CATALOG_API_ORIGIN = {
          type  = "plain_text"
          value = google_cloud_run_v2_service.api.uri
        }
      }
    }
  }
}
