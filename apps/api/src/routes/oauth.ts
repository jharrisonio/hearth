import { oauthConsentSchema, oauthDenySchema, safeNextPath } from "@hearth/shared";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { Hono } from "hono";
import { findUserById } from "../accounts.js";
import { readSessionUserId, sessionCookieName } from "../actor.js";
import { readEnv } from "../env.js";
import { HttpError, parseBody } from "../errors.js";
import { readJson } from "../http.js";
import {
  HEARTH_SCOPE,
  OAuthError,
  authorizationServerMetadata,
  beginAuthorization,
  canonicalResource,
  clientForAuthorize,
  denyAuthorization,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  approveAuthorization,
  parseAgentRoster,
  previewAuthorization,
  protectedResourceMetadata,
  redirectMatches,
  registerDynamicClient,
  resourceMatches,
} from "../oauth.js";

export const oauthRoutes = new Hono();

oauthRoutes.get("/.well-known/oauth-protected-resource", (c) => resourceMetadata(c));
oauthRoutes.get("/.well-known/oauth-protected-resource/mcp", (c) => resourceMetadata(c));
oauthRoutes.get("/.well-known/oauth-authorization-server", (c) => serverMetadata(c));
oauthRoutes.get("/.well-known/openid-configuration", (c) => serverMetadata(c));

oauthRoutes.post("/register", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return oauthJson(c, 400, "invalid_client_metadata", "Body must be JSON.");
  }
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((uri): uri is string => typeof uri === "string") : [];
  try {
    const registered = await registerDynamicClient({
      redirectUris,
      clientName: typeof body.client_name === "string" ? body.client_name : undefined,
      tokenEndpointAuthMethod: typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : undefined,
      grantTypes: stringArray(body.grant_types),
      responseTypes: stringArray(body.response_types),
    });
    c.header("cache-control", "no-store");
    return c.json(registered, 201);
  } catch (err) {
    return asOAuth(c, err);
  }
});

oauthRoutes.get("/authorize", async (c) => {
  const clientId = c.req.query("client_id") ?? "";
  const redirectUri = c.req.query("redirect_uri") ?? "";
  const responseType = c.req.query("response_type");
  const challenge = c.req.query("code_challenge") ?? "";
  const method = c.req.query("code_challenge_method");
  const state = c.req.query("state");
  const scope = c.req.query("scope");
  const resource = c.req.query("resource");
  if (!clientId || clientId.length > 2048) return oauthJson(c, 400, "invalid_request", "client_id is required.");
  let client: Awaited<ReturnType<typeof clientForAuthorize>>;
  try {
    client = await clientForAuthorize(clientId);
  } catch (err) {
    return asOAuth(c, err);
  }
  if (!client) return oauthJson(c, 400, "invalid_client", "Unknown client.");
  const redirectOk = redirectMatches(client.redirectUris, redirectUri);
  const fail = (error: string, description: string) => {
    if (!redirectOk) return oauthJson(c, 400, error, description);
    const url = new URL(redirectUri);
    url.searchParams.set("error", error);
    url.searchParams.set("error_description", description);
    if (state) url.searchParams.set("state", state);
    return c.redirect(url.toString());
  };
  if (!redirectOk) return oauthJson(c, 400, "invalid_request", "redirect_uri is not registered for this client.");
  if (responseType !== "code") return fail("unsupported_response_type", "response_type must be code.");
  if (method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
    return fail("invalid_request", "PKCE S256 code_challenge is required.");
  }
  if (state && state.length > 512) return fail("invalid_request", "state is too long.");
  if (scope && scope !== HEARTH_SCOPE) return fail("invalid_scope", "The only scope is hearth.");
  const env = readEnv();
  if (!resourceMatches(env.oauthIssuer, resource)) return fail("invalid_target", "resource must be this Hearth MCP server.");
  const pending = await beginAuthorization({
    clientId: client.clientId,
    redirectUri,
    codeChallenge: challenge,
    state: state ?? null,
    resource: canonicalResource(env.oauthIssuer),
    scope: HEARTH_SCOPE,
    agents: parseAgentRoster(c.req.query("agents")),
  });
  const next = safeNextPath(`/oauth/consent?request=${pending.id}`) ?? "/";
  return c.redirect(`${env.publicUrl}${next}`);
});

oauthRoutes.post("/token", async (c) => {
  const params = await readOauthBody(c);
  const grantType = params.get("grant_type") ?? "";
  const clientId = params.get("client_id") ?? "";
  const resource = params.get("resource") ?? undefined;
  c.header("cache-control", "no-store");
  try {
    if (!clientId) return oauthJson(c, 400, "invalid_client", "client_id is required.");
    if (grantType === "authorization_code") {
      const tokens = await exchangeAuthorizationCode({
        code: params.get("code") ?? "",
        clientId,
        redirectUri: params.get("redirect_uri") ?? "",
        codeVerifier: params.get("code_verifier") ?? "",
        resource,
      });
      return c.json(tokens);
    }
    if (grantType === "refresh_token") {
      const tokens = await exchangeRefreshToken({
        refreshToken: params.get("refresh_token") ?? "",
        clientId,
        resource,
      });
      return c.json(tokens);
    }
    return oauthJson(c, 400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token.");
  } catch (err) {
    return asOAuth(c, err);
  }
});

oauthRoutes.get("/oauth/request", async (c) => {
  const requestId = c.req.query("request") ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new HttpError(400, "invalid_request", "Missing connection request.");
  }
  return c.json(await previewAuthorization(requestId));
});

oauthRoutes.post("/oauth/consent", async (c) => {
  const userId = await signedInUser(c);
  const body = parseBody(oauthConsentSchema, await readJson(c));
  const result = await approveAuthorization({
    requestId: body.request,
    userId,
    teamIds: body.teamIds,
    bots: body.bots ?? [],
  });
  return c.json({ redirectTo: result.redirectTo });
});

oauthRoutes.post("/oauth/consent/deny", async (c) => {
  const userId = await signedInUser(c);
  const body = parseBody(oauthDenySchema, await readJson(c));
  const result = await denyAuthorization(body.request, userId);
  return c.json({ redirectTo: result.redirectTo });
});

function resourceMetadata(c: Context) {
  const env = readEnv();
  c.header("cache-control", "public, max-age=300");
  return c.json(protectedResourceMetadata(env.oauthIssuer));
}

function serverMetadata(c: Context) {
  const env = readEnv();
  c.header("cache-control", "public, max-age=300");
  return c.json(authorizationServerMetadata(env.oauthIssuer));
}

async function signedInUser(c: Context) {
  const env = readEnv();
  const userId = readSessionUserId(getCookie(c, sessionCookieName()), env.sessionSecret);
  if (!userId) throw new HttpError(401, "unauthorized", "Sign in required.");
  const user = await findUserById(userId);
  if (!user) throw new HttpError(401, "unauthorized", "Sign in required.");
  return user.id;
}

async function readOauthBody(c: Context) {
  const type = c.req.header("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const params = new URLSearchParams();
    if (body) {
      for (const [key, value] of Object.entries(body)) {
        if (typeof value === "string") params.set(key, value);
      }
    }
    return params;
  }
  return new URLSearchParams(await c.req.text());
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function oauthJson(c: Context, status: 400 | 401, error: string, description: string) {
  c.header("cache-control", "no-store");
  return c.json({ error, error_description: description }, status);
}

function asOAuth(c: Context, err: unknown) {
  if (err instanceof OAuthError) return oauthJson(c, err.status, err.code, err.message);
  throw err;
}
