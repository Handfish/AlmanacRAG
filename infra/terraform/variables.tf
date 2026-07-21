# One base name threads through every resource so the whole stack is greppable and
# CI can derive names (service = "${project_name}-api", repo = "${project_name}").
variable "project_name" {
  description = "Base name for the Neon project, Cloud Run service, Artifact Registry repo, and secrets."
  type        = string
  default     = "almanac"
}

# ── GCP (Cloud Run + Artifact Registry + Secret Manager) ──────────────────────
variable "gcp_project_id" {
  description = "Target GCP project id."
  type        = string
}

variable "gcp_region" {
  description = "Region for Cloud Run, Artifact Registry, and secret replicas. Keep it near neon_region_id."
  type        = string
  default     = "us-east1"
}

variable "server_image" {
  description = <<-EOT
    Container image for the API service. On first `apply` this is a public placeholder
    so the service can be created; CI (gcloud run deploy) then pushes real revisions.
    Terraform ignores image drift (lifecycle.ignore_changes), so CI and Terraform don't fight.
  EOT
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "cloud_run_max_instances" {
  description = "Upper bound on Cloud Run instances. min stays 0 (scale-to-zero, free tier)."
  type        = number
  default     = 3
}

# ── Neon (Postgres + pgvector) ────────────────────────────────────────────────
variable "neon_api_key" {
  description = "Neon API key. Leave empty to use the NEON_API_KEY env var instead."
  type        = string
  sensitive   = true
  default     = ""
}

variable "neon_region_id" {
  description = "Neon region (e.g. aws-us-east-2). Pick one near gcp_region to keep Cloud Run→DB latency low."
  type        = string
  default     = "aws-us-east-2"
}

# ── Cloudflare (Pages) ────────────────────────────────────────────────────────
variable "cloudflare_api_token" {
  description = "Cloudflare API token with Pages edit. Leave empty to use CLOUDFLARE_API_TOKEN env var."
  type        = string
  sensitive   = true
  default     = ""
}

variable "cloudflare_account_id" {
  description = "Cloudflare account id that owns the Pages project."
  type        = string
}

variable "cf_pages_project_name" {
  description = "Cloudflare Pages project name (also the *.pages.dev subdomain). The public brand."
  type        = string
  default     = "almanac"
}

# ── App runtime secret ────────────────────────────────────────────────────────
variable "gemini_api_key" {
  description = "Runtime LLM key — the answerer/router/embedder adapters are Gemini (main.ts)."
  type        = string
  sensitive   = true
}
