"""Server provisioning owned by the backend (no Terraform runtime required)."""

from app.core.security import SENSITIVE

# Provisioning user-data can contain passwords, join tokens and private scripts.
# Register these fields with the shared gateway redactor before any request runs.
SENSITIVE.update({"user_data", "cloud_init", "cloud_init_content"})
