provider "google" {
  project = var.gcp_project_id
  region  = var.gcp_region
}

# api_key falls back to the NEON_API_KEY env var when the variable is left empty
# (null unsets the argument; "" would override the env var with an empty key).
provider "neon" {
  api_key = var.neon_api_key != "" ? var.neon_api_key : null
}

# api_token falls back to CLOUDFLARE_API_TOKEN the same way.
provider "cloudflare" {
  api_token = var.cloudflare_api_token != "" ? var.cloudflare_api_token : null
}
