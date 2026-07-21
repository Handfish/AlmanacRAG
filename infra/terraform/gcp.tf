# ── Enable the APIs this stack touches ────────────────────────────────────────
locals {
  gcp_services = [
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
  ]
}

resource "google_project_service" "svc" {
  for_each           = toset(local.gcp_services)
  service            = each.value
  disable_on_destroy = false
}

# ── Artifact Registry: where CI pushes the server image ───────────────────────
resource "google_artifact_registry_repository" "docker" {
  location      = var.gcp_region
  repository_id = var.project_name
  format        = "DOCKER"
  description   = "Server images for the catalog Cloud Run service"
  depends_on    = [google_project_service.svc]
}

# ── Runtime service account (least privilege: only reads the secrets it needs) ─
resource "google_service_account" "api" {
  account_id   = "${var.project_name}-run"
  display_name = "Catalog API (Cloud Run runtime)"
}

# ── Secrets ───────────────────────────────────────────────────────────────────
# POSTGRES_URL  → pooled Neon URI (runtime; -pooler host, transaction pooling).
# POSTGRES_ADMIN_URL → direct Neon URI (migrations only; CI reads it, server does not).
# GEMINI_API_KEY → runtime LLM key.
resource "google_secret_manager_secret" "postgres_url" {
  secret_id = "${var.project_name}-postgres-url"
  replication {
    auto {}
  }
  depends_on = [google_project_service.svc]
}
resource "google_secret_manager_secret_version" "postgres_url" {
  secret      = google_secret_manager_secret.postgres_url.id
  secret_data = neon_project.catalog.connection_uri_pooler
}

resource "google_secret_manager_secret" "postgres_admin_url" {
  secret_id = "${var.project_name}-postgres-admin-url"
  replication {
    auto {}
  }
  depends_on = [google_project_service.svc]
}
resource "google_secret_manager_secret_version" "postgres_admin_url" {
  secret      = google_secret_manager_secret.postgres_admin_url.id
  secret_data = neon_project.catalog.connection_uri
}

resource "google_secret_manager_secret" "gemini_api_key" {
  secret_id = "${var.project_name}-gemini-api-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.svc]
}
resource "google_secret_manager_secret_version" "gemini_api_key" {
  secret      = google_secret_manager_secret.gemini_api_key.id
  secret_data = var.gemini_api_key
}

# The runtime SA reads only the two secrets the serving process needs. The admin URL is
# intentionally NOT granted here — only CI (via its own auth) accesses it for migrations.
resource "google_secret_manager_secret_iam_member" "postgres_url" {
  secret_id = google_secret_manager_secret.postgres_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}
resource "google_secret_manager_secret_iam_member" "gemini_api_key" {
  secret_id = google_secret_manager_secret.gemini_api_key.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

# ── Cloud Run service ─────────────────────────────────────────────────────────
resource "google_cloud_run_v2_service" "api" {
  name     = "${var.project_name}-api"
  location = var.gcp_region

  # Free-tier / hobby: let `terraform destroy` remove it.
  deletion_protection = false

  template {
    service_account = google_service_account.api.email

    scaling {
      min_instance_count = 0 # scale to zero (free tier). Set 1 to kill cold starts — costs money.
      max_instance_count = var.cloud_run_max_instances
    }

    containers {
      image = var.server_image

      # No `ports` block: Cloud Run injects PORT=8080 and the app's AppConfig (config.ts)
      # reads PORT, so the container obeys whatever Cloud Run sets.

      resources {
        limits   = { cpu = "1", memory = "512Mi" }
        cpu_idle = true # request-based billing: no CPU charged while idle
      }

      # Pooled Postgres URL + Gemini key, both from Secret Manager. The admin URL is not
      # mounted — the serving process (SqlLive) only uses POSTGRES_URL.
      env {
        name = "POSTGRES_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.postgres_url.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "GEMINI_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.gemini_api_key.secret_id
            version = "latest"
          }
        }
      }
    }
  }

  # CI (gcloud run deploy) pushes the real image on every merge; Terraform must not revert
  # it back to the placeholder. `client`/`client_version` also churn on each gcloud deploy.
  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_project_service.svc,
    google_secret_manager_secret_version.postgres_url,
    google_secret_manager_secret_version.gemini_api_key,
    google_secret_manager_secret_iam_member.postgres_url,
    google_secret_manager_secret_iam_member.gemini_api_key,
  ]
}

# ── Public, unauthenticated access ────────────────────────────────────────────
# The Pages edge proxy calls this over the public internet. If an org policy blocks
# allUsers on Cloud Run (domain-restricted sharing), this apply fails — see README.
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.api.name
  location = google_cloud_run_v2_service.api.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}
