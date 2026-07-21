terraform {
  required_version = ">= 1.6"

  # Local state (per the deploy plan). The state file holds Neon/Gemini secrets in
  # plaintext, so it is gitignored (.gitignore) — keep it off shared storage. To move
  # to a GCS backend later, add a `backend "gcs" {}` block here and `terraform init -migrate-state`.

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    neon = {
      # Neon-sponsored, recommended in Neon's own docs. Auto-creates the default
      # branch/endpoint/database/role and exposes pooled + direct connection URIs.
      source  = "kislerdm/neon"
      version = "~> 0.13"
    }
    cloudflare = {
      # v5 = the OpenAPI-generated rewrite; schemas differ from v4.
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}
