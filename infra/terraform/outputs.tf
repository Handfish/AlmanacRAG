output "cloud_run_url" {
  description = "Public URL of the API service (also wired into the Pages proxy as CATALOG_API_ORIGIN)."
  value       = google_cloud_run_v2_service.api.uri
}

output "cloud_run_service" {
  description = "Cloud Run service name — CI targets this with `gcloud run deploy`."
  value       = google_cloud_run_v2_service.api.name
}

output "artifact_registry_image_base" {
  description = "Base image path for CI pushes: append `/server:<tag>`."
  value       = "${var.gcp_region}-docker.pkg.dev/${var.gcp_project_id}/${google_artifact_registry_repository.docker.repository_id}"
}

output "pages_project_name" {
  description = "Cloudflare Pages project name — CI targets this with `wrangler pages deploy`."
  value       = cloudflare_pages_project.web.name
}

output "pages_url" {
  description = "The production Pages URL (Cloudflare's actual assigned subdomain — may carry a suffix if the name collided globally)."
  value       = "https://${cloudflare_pages_project.web.subdomain}"
}

# Sensitive — surface with `terraform output -raw neon_postgres_url_pooled`.
output "neon_postgres_url_pooled" {
  description = "Pooled Neon URI (runtime). Mirrored into Secret Manager as <project_name>-postgres-url."
  value       = neon_project.catalog.connection_uri_pooler
  sensitive   = true
}

output "neon_postgres_admin_url" {
  description = "Direct Neon URI (migrations only). Mirrored into Secret Manager as <project_name>-postgres-admin-url."
  value       = neon_project.catalog.connection_uri
  sensitive   = true
}
