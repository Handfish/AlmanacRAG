# Neon project — Postgres 16 with pgvector (migration 0002 runs CREATE EXTENSION vector;
# 0004 stores halfvec embeddings). The project auto-creates the primary branch, a compute
# endpoint, a database, and an owner role; we only name the database/role and pin compute.
resource "neon_project" "catalog" {
  name       = var.project_name
  region_id  = var.neon_region_id
  pg_version = 16

  # Free plan caps point-in-time history at 6h (max 21600s); the provider default
  # (86400s / 1 day) is rejected (HTTP 400). App history lives in tables, not Neon PITR.
  history_retention_seconds = 21600

  # Free-tier compute: 0.25 CU. Scale-to-zero (~5 min idle → ~500ms "cold wake") is the
  # Free plan default and can't be set explicitly — the plan rejects suspend_timeout_seconds
  # (HTTP 412). Raise autoscaling_limit_max_cu within your plan's ceiling for more headroom.
  default_endpoint_settings {
    autoscaling_limit_min_cu = 0.25
    autoscaling_limit_max_cu = 0.25
  }

  # Deterministic names for the auto-provisioned database + owner role, so the connection
  # URIs (and anything reading them) are stable across recreates.
  branch {
    database_name = "catalog"
    role_name     = "catalog_owner"
  }
}
