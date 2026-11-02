# Railway

`.railway/railway.ts` describes the Hearth project: a Postgres database, an `api` service, and a `web` service. It does not contain production secrets and it does not deploy anything on its own.

Railway reads this file when you run the CLI against a project you have already created and linked:

```bash
railway login
railway link
railway config plan
railway config apply
```

Review the plan before applying. `preserve()` on `SESSION_SECRET`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET` keeps whatever is already stored in Railway. Set those in the dashboard before the API’s first deploy.

Service root directories stay at the repository root. Each service sets `RAILWAY_DOCKERFILE_PATH` to its Dockerfile (`/apps/api/Dockerfile` or `/apps/web/Dockerfile`).
