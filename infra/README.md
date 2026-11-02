# Infra

`terraform/` is a placeholder module for a later deploy. It does not create cloud resources.

The path that runs locally is `docker-compose.yml` at the repository root: Postgres, the API, and the web app.

Railway’s project shape is `.railway/railway.ts`: a Postgres plugin plus separate `api` and `web` services. Apply it with the Railway CLI after you link a project. It does not contain secrets and it does not deploy on its own.
