export type Env = {
  databaseUrl: string;
  sessionSecret: string;
  devAuth: boolean;
  googleClientId: string;
  googleClientSecret: string;
  publicUrl: string;
  /** Origin of the MCP resource and the OAuth authorization server. No trailing slash. */
  oauthIssuer: string;
  port: number;
  seed: boolean;
};

export function readEnv(): Env {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const sessionSecret = process.env.SESSION_SECRET ?? "";
  if (sessionSecret.length < 16) {
    throw new Error("SESSION_SECRET must be at least 16 characters");
  }
  const port = Number(process.env.PORT ?? 43124);
  if (!Number.isInteger(port) || port <= 0) throw new Error("PORT must be a positive integer");
  return {
    databaseUrl,
    sessionSecret,
    devAuth: process.env.DEV_AUTH === "1",
    googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    publicUrl: resolvePublicUrl(),
    oauthIssuer: resolveOauthIssuer(port),
    port,
    seed: process.env.SEED === "1",
  };
}

export function assertRuntime(env: Env) {
  if (process.env.RAILWAY_ENVIRONMENT && env.devAuth) {
    throw new Error("DEV_AUTH must be 0 on Railway. Dev sign-in is only for a local machine.");
  }
  if (process.env.RAILWAY_ENVIRONMENT && env.seed) {
    console.warn("SEED=1 on Railway creates the demo James and Naomi accounts. Set SEED=0 for a real household.");
  }
  if (process.env.RAILWAY_ENVIRONMENT && !env.oauthIssuer.startsWith("https://")) {
    console.warn("OAUTH_ISSUER is not https. A remote MCP client will refuse the connector.");
  }
}

function resolveOauthIssuer(port: number) {
  const explicit = process.env.OAUTH_ISSUER?.trim().replace(/\/$/, "");
  if (explicit) return explicit;
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (domain) return `https://${domain}`;
  return `http://127.0.0.1:${port}`;
}

export function mcpResourceUrl(issuer: string) {
  return `${issuer.replace(/\/$/, "")}/mcp`;
}

function resolvePublicUrl() {
  const explicit = process.env.PUBLIC_URL?.trim().replace(/\/$/, "");
  if (explicit) return explicit;
  const domain = process.env.WEB_PUBLIC_DOMAIN?.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (domain) return `https://${domain}`;
  return "http://127.0.0.1:43123";
}
