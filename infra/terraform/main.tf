# Hearth deploy stub.
#
# Local development does not use Terraform. Run `docker compose up --build`
# from the repository root (Postgres, API, and the React PWA).
#
# When you pick a host, this module is the place for:
# - a managed Postgres instance
# - the API container, with the env vars listed in the README
# - the PWA, either as a static site or a container that proxies /api
#
# Do not apply this stub expecting infrastructure to appear.

output "local_stack" {
  value = "Use docker compose at the repository root. This module is a placeholder only."
}
