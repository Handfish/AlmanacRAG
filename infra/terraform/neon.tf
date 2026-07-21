# Neon project — Postgres 16 with pgvector (migration 0002 runs CREATE EXTENSION vector;
# 0004 stores halfvec embeddings). The project auto-creates the primary branch, a compute
# endpoint, a database, and an owner role; we only name the database/role and pin compute.
resource "neon_project" "catalog" {
  name       = var.project_name
  region_id  = var.neon_region_id
  pg_version = 16

  # Free-tier compute: 0.25 CU, scale-to-zero after 5 min idle (the ~500ms "cold wake"
  # in the hosting plan). Raise autoscaling_limit_max_cu within your plan's ceiling if
  # query latency ever needs more headroom.
  default_endpoint_settings {
    autoscaling_limit_min_cu = 0.25
    autoscaling_limit_max_cu = 0.25
    suspend_timeout_seconds  = 300
  }

  # Deterministic names for the auto-provisioned database + owner role, so the connection
  # URIs (and anything reading them) are stable across recreates.
  branch {
    database_name = "catalog"
    role_name     = "catalog_owner"
  }
}
