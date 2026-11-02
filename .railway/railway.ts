import { defineRailway, postgres, preserve, project, service } from "railway/iac";

/**
 * One Railway project: Postgres, the API, and the web app.
 *
 * Both services build from the repository root. The Dockerfiles copy the pnpm
 * workspace, so the service root directory must stay `/`. The Dockerfile path
 * is selected with RAILWAY_DOCKERFILE_PATH.
 *
 * Secrets are preserve() placeholders. Set them in the Railway dashboard.
 * This file does not create or deploy a project; run `railway config plan`
 * yourself after `railway login` and `railway link`.
 */
export default defineRailway(() => {
  const db = postgres("postgres");

  const web = service("web", {
    healthcheck: "/health",
    healthcheckTimeout: 60,
    env: {
      RAILWAY_DOCKERFILE_PATH: "/apps/web/Dockerfile",
    },
  });

  const api = service("api", {
    healthcheck: "/health",
    healthcheckTimeout: 300,
    env: {
      RAILWAY_DOCKERFILE_PATH: "/apps/api/Dockerfile",
      DATABASE_URL: db.env.DATABASE_URL,
      WEB_PUBLIC_DOMAIN: web.env.RAILWAY_PUBLIC_DOMAIN,
      SESSION_SECRET: preserve(),
      GOOGLE_CLIENT_ID: preserve(),
      GOOGLE_CLIENT_SECRET: preserve(),
      DEV_AUTH: "0",
      SEED: "0",
    },
  });

  web.variables = {
    ...web.variables,
    API_HOST: api.env.RAILWAY_PRIVATE_DOMAIN,
    API_PORT: api.env.PORT,
  };

  return project("hearth", {
    resources: [db, api, web],
  });
});
