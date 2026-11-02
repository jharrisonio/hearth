import { oauthAgentSchema, type OAuthAgent } from "@hearth/shared";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { findUserById } from "./accounts.js";
import { upsertBot } from "./bots.js";
import { db } from "./db.js";
import { mcpResourceUrl, readEnv } from "./env.js";
import { HttpError } from "./errors.js";
import {
  memberships,
  oauthClients,
  oauthCodes,
  oauthGrantTeams,
  oauthGrants,
  oauthRequests,
  oauthTokens,
} from "./schema.js";
import { hashToken } from "./tokens.js";

/** Scope a connector receives. Team choice lives on the grant, not in extra scopes. */
export const HEARTH_SCOPE = "hearth";

const ACCESS_TTL_SEC = 60 * 60;
const REFRESH_TTL_SEC = 30 * 24 * 60 * 60;
const CODE_TTL_SEC = 5 * 60;
const REQUEST_TTL_SEC = 10 * 60;
const CIMD_CACHE_MS = 15 * 60 * 1000;

/**
 * Grok Bot and Cursor register these custom-scheme callbacks alongside https and localhost.
 * Anything else with a non-http(s) scheme is rejected so an install cannot be an open redirect.
 */
const CUSTOM_REDIRECTS: { protocol: string; hostname: string; pathname: string }[] = [
  { protocol: "cursor:", hostname: "anysphere.cursor-mcp", pathname: "/oauth/callback" },
  { protocol: "grokbot:", hostname: "mcp", pathname: "/oauth/callback" },
];

const cimdSchema = z
  .object({
    client_id: z.string().min(1).max(2048),
    client_name: z.string().trim().min(1).max(120),
    redirect_uris: z.array(z.string().min(1).max(2048)).min(1).max(10),
    token_endpoint_auth_method: z.literal("none").optional(),
  })
  .passthrough();

function sameResource(stored: string, requested: string | undefined) {
  if (!requested) return true;
  const left = stored.trim().replace(/\/$/, "");
  const right = requested.trim().replace(/\/$/, "");
  return left === right || left === `${right}/mcp` || right === `${left}/mcp`;
}

export function canonicalResource(issuer: string) {
  return mcpResourceUrl(issuer);
}

/** Accept the MCP path and the bare issuer. Clients differ on which they send. */
export function resourceMatches(issuer: string, resource: string | undefined) {
  if (!resource) return true;
  const trimmed = resource.trim().replace(/\/$/, "");
  const origin = issuer.replace(/\/$/, "");
  return trimmed === origin || trimmed === canonicalResource(issuer);
}

export function isLoopback(url: URL) {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function isAllowedRedirect(uri: string) {
  if (!uri || uri.length > 2048 || /[\r\n\0\\@]/.test(uri) || uri.includes("#")) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:" && url.hostname.length > 0) return true;
  if (url.protocol === "http:" && isLoopback(url)) return true;
  return CUSTOM_REDIRECTS.some(
    (entry) => url.protocol === entry.protocol && url.hostname === entry.hostname && url.pathname === entry.pathname && url.search === "",
  );
}

/** Exact match, except a loopback port may differ from the registered one (RFC 8252). */
export function redirectMatches(registered: string[], requested: string) {
  if (!isAllowedRedirect(requested)) return false;
  if (registered.includes(requested)) return true;
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopback(req)) return false;
  return registered.some((entry) => {
    try {
      const url = new URL(entry);
      return (
        isLoopback(url) &&
        url.protocol === req.protocol &&
        url.hostname === req.hostname &&
        url.pathname === req.pathname &&
        url.search === req.search
      );
    } catch {
      return false;
    }
  });
}

export function redirectHost(uri: string) {
  try {
    const url = new URL(uri);
    if (url.protocol === "http:" || url.protocol === "https:") return url.host;
    return `${url.protocol}//${url.host}`;
  } catch {
    return uri;
  }
}

export function parseAgentRoster(raw: string | undefined): OAuthAgent[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const result = z.array(oauthAgentSchema).max(20).safeParse(parsed);
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

export function pkceS256(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function pkceMatches(verifier: string, challenge: string) {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return false;
  const digest = pkceS256(verifier);
  const a = Buffer.from(digest);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function protectedResourceMetadata(issuer: string) {
  return {
    resource: canonicalResource(issuer),
    authorization_servers: [issuer],
    scopes_supported: [HEARTH_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Hearth",
  };
}

export function authorizationServerMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [HEARTH_SCOPE],
    client_id_metadata_document_supported: true,
  };
}

export function bearerChallenge(message: string, presented: boolean) {
  const issuer = readEnv().oauthIssuer;
  return new Response(JSON.stringify({ error: { code: "unauthorized", message } }), {
    status: 401,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "www-authenticate": wwwAuthenticate(issuer, presented, presented ? message : undefined),
      "cache-control": "no-store",
    },
  });
}

export function wwwAuthenticate(issuer: string, invalid: boolean, description?: string) {
  const parts = [
    `Bearer realm="hearth"`,
    `resource_metadata="${issuer}/.well-known/oauth-protected-resource"`,
    `scope="${HEARTH_SCOPE}"`,
  ];
  if (invalid) {
    parts.push(`error="invalid_token"`);
    if (description) parts.push(`error_description="${description.replace(/"/g, "")}"`);
  }
  return parts.join(", ");
}

export async function registerDynamicClient(input: {
  redirectUris: string[];
  clientName?: string;
  tokenEndpointAuthMethod?: string;
  grantTypes?: string[];
  responseTypes?: string[];
}) {
  if (!input.redirectUris.length || input.redirectUris.length > 10) {
    throw new OAuthError(400, "invalid_client_metadata", "redirect_uris must list one to ten URIs.");
  }
  if (input.redirectUris.some((uri) => !isAllowedRedirect(uri))) {
    throw new OAuthError(
      400,
      "invalid_client_metadata",
      "A redirect URI must be https, a loopback http address, or a known Cursor or Grok callback.",
    );
  }
  const method = input.tokenEndpointAuthMethod ?? "none";
  if (method !== "none") {
    throw new OAuthError(400, "invalid_client_metadata", "This server only registers public clients.");
  }
  const grants = input.grantTypes ?? ["authorization_code", "refresh_token"];
  if (grants.some((grant) => grant !== "authorization_code" && grant !== "refresh_token")) {
    throw new OAuthError(400, "invalid_client_metadata", "Only authorization_code and refresh_token are supported.");
  }
  const responses = input.responseTypes ?? ["code"];
  if (responses.some((response) => response !== "code")) {
    throw new OAuthError(400, "invalid_client_metadata", "Only response_type code is supported.");
  }
  const clientName = (input.clientName ?? "MCP client").trim();
  if (!clientName || clientName.length > 120) {
    throw new OAuthError(400, "invalid_client_metadata", "client_name must be 1 to 120 characters.");
  }
  const clientId = `hcl_${randomBytes(16).toString("base64url")}`;
  const [row] = await db
    .insert(oauthClients)
    .values({
      clientId,
      clientName,
      redirectUris: input.redirectUris,
      tokenEndpointAuthMethod: "none",
      source: "dcr",
    })
    .returning();
  if (!row) throw new Error("Failed to register client");
  return {
    client_id: row.clientId,
    client_id_issued_at: Math.floor(row.createdAt.getTime() / 1000),
    client_name: row.clientName,
    redirect_uris: row.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

export async function clientForAuthorize(clientId: string) {
  if (isMetadataClientId(clientId)) return loadMetadataClient(clientId);
  return findClient(clientId);
}

export async function beginAuthorization(input: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  resource: string;
  scope: string;
  agents: OAuthAgent[];
}) {
  const [row] = await db
    .insert(oauthRequests)
    .values({
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      state: input.state,
      resource: input.resource,
      scope: input.scope,
      agents: input.agents,
      expiresAt: new Date(Date.now() + REQUEST_TTL_SEC * 1000),
    })
    .returning();
  if (!row) throw new Error("Failed to store the authorisation request");
  return row;
}

export async function previewAuthorization(requestId: string) {
  const row = await loadOpenRequest(requestId);
  const client = await findClient(row.clientId);
  if (!client) throw new HttpError(400, "invalid_request", "That client is no longer registered.");
  return {
    requestId: row.id,
    clientName: client.clientName,
    redirectUri: row.redirectUri,
    redirectHost: redirectHost(row.redirectUri),
    loopback: isLoopback(new URL(row.redirectUri)),
    scope: row.scope,
    agents: row.agents,
    expiresAt: row.expiresAt.toISOString(),
  };
}

export async function approveAuthorization(input: {
  requestId: string;
  userId: string;
  teamIds: string[];
  bots: OAuthAgent[];
}) {
  const request = await loadOpenRequest(input.requestId);
  const client = await findClient(request.clientId);
  if (!client) throw new HttpError(400, "invalid_request", "That client is no longer registered.");
  const teamIds = [...new Set(input.teamIds)];
  await assertOwnerOfTeams(input.userId, teamIds);
  const seen = new Map<string, string>();
  for (const bot of input.bots) {
    seen.set(bot.agentId, bot.name);
  }
  for (const teamId of teamIds) {
    for (const [agentId, name] of seen) {
      await upsertBot(teamId, agentId, name);
    }
  }
  const code = `hoc_${randomBytes(32).toString("base64url")}`;
  const grantId = await db.transaction(async (tx) => {
    const [consumed] = await tx
      .update(oauthRequests)
      .set({ consumedAt: new Date() })
      .where(and(eq(oauthRequests.id, request.id), isNull(oauthRequests.consumedAt)))
      .returning();
    if (!consumed) throw new HttpError(409, "conflict", "This connection was already answered.");
    const [grant] = await tx
      .insert(oauthGrants)
      .values({
        oauthClientId: client.id,
        userId: input.userId,
        resource: request.resource,
        scope: request.scope,
      })
      .returning();
    if (!grant) throw new Error("Failed to store the grant");
    await tx.insert(oauthGrantTeams).values(teamIds.map((teamId) => ({ grantId: grant.id, teamId })));
    await tx.insert(oauthCodes).values({
      codeHash: hashToken(code),
      grantId: grant.id,
      clientId: client.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      resource: request.resource,
      scope: request.scope,
      expiresAt: new Date(Date.now() + CODE_TTL_SEC * 1000),
    });
    return grant.id;
  });
  return { redirectTo: callbackUrl(request.redirectUri, { code, state: request.state }), grantId };
}

export async function denyAuthorization(requestId: string, userId: string) {
  const request = await loadOpenRequest(requestId);
  const user = await findUserById(userId);
  if (!user) throw new HttpError(401, "unauthorized", "Sign in required.");
  const [consumed] = await db
    .update(oauthRequests)
    .set({ consumedAt: new Date() })
    .where(and(eq(oauthRequests.id, request.id), isNull(oauthRequests.consumedAt)))
    .returning();
  if (!consumed) throw new HttpError(409, "conflict", "This connection was already answered.");
  return { redirectTo: callbackUrl(request.redirectUri, { error: "access_denied", state: request.state }) };
}

export async function exchangeAuthorizationCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  resource: string | undefined;
}) {
  const [code] = await db.select().from(oauthCodes).where(eq(oauthCodes.codeHash, hashToken(input.code))).limit(1);
  if (!code) throw new OAuthError(400, "invalid_grant", "Unknown authorisation code.");
  if (code.clientId !== input.clientId || code.redirectUri !== input.redirectUri) {
    throw new OAuthError(400, "invalid_grant", "The code does not match this client.");
  }
  if (!sameResource(code.resource, input.resource)) {
    throw new OAuthError(400, "invalid_target", "The resource does not match the code.");
  }
  if (code.usedAt) {
    await revokeGrant(code.grantId);
    throw new OAuthError(400, "invalid_grant", "That code was already used.");
  }
  if (code.expiresAt.getTime() <= Date.now()) {
    throw new OAuthError(400, "invalid_grant", "That code has expired.");
  }
  if (!pkceMatches(input.codeVerifier, code.codeChallenge)) {
    throw new OAuthError(400, "invalid_grant", "PKCE verification failed.");
  }
  const [used] = await db
    .update(oauthCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(oauthCodes.id, code.id), isNull(oauthCodes.usedAt)))
    .returning();
  if (!used) {
    await revokeGrant(code.grantId);
    throw new OAuthError(400, "invalid_grant", "That code was already used.");
  }
  const grant = await liveGrant(code.grantId);
  if (!grant) throw new OAuthError(400, "invalid_grant", "That grant is no longer active.");
  return issueTokenPair(grant.id, code.resource, code.scope);
}

export async function exchangeRefreshToken(input: { refreshToken: string; clientId: string; resource: string | undefined }) {
  const hash = hashToken(input.refreshToken);
  const outcome = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(oauthTokens).where(eq(oauthTokens.refreshHash, hash)).limit(1);
    if (!row) return { error: new OAuthError(400, "invalid_grant", "Unknown refresh token.") };
    const [grant] = await tx
      .select({ grant: oauthGrants, clientId: oauthClients.clientId })
      .from(oauthGrants)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.oauthClientId))
      .where(eq(oauthGrants.id, row.grantId))
      .limit(1);
    if (!grant || grant.clientId !== input.clientId) {
      return { error: new OAuthError(400, "invalid_grant", "The refresh token does not match this client.") };
    }
    if (row.revokedAt || grant.grant.revokedAt) {
      await tx.update(oauthGrants).set({ revokedAt: new Date() }).where(eq(oauthGrants.id, row.grantId));
      await tx
        .update(oauthTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(oauthTokens.grantId, row.grantId), isNull(oauthTokens.revokedAt)));
      return { error: new OAuthError(400, "invalid_grant", "That refresh token was already used.") };
    }
    if (!row.refreshExpiresAt || row.refreshExpiresAt.getTime() <= Date.now()) {
      return { error: new OAuthError(400, "invalid_grant", "That refresh token has expired.") };
    }
    if (!sameResource(row.resource, input.resource)) {
      return { error: new OAuthError(400, "invalid_target", "The resource does not match the token.") };
    }
    const [retired] = await tx
      .update(oauthTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(oauthTokens.id, row.id), isNull(oauthTokens.revokedAt)))
      .returning();
    if (!retired) return { error: new OAuthError(400, "invalid_grant", "That refresh token was already used.") };
    return { tokens: await insertTokenPair(tx, grant.grant.id, row.resource, row.scope) };
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.tokens;
}

export async function revokeGrant(grantId: string) {
  await db.update(oauthGrants).set({ revokedAt: new Date() }).where(eq(oauthGrants.id, grantId));
  await db
    .update(oauthTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(oauthTokens.grantId, grantId), isNull(oauthTokens.revokedAt)));
}

export class OAuthError extends Error {
  constructor(
    readonly status: 400 | 401,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

export function callbackUrl(redirectUri: string, params: { code?: string; state?: string | null; error?: string }) {
  const url = new URL(redirectUri);
  if (params.code) url.searchParams.set("code", params.code);
  if (params.error) url.searchParams.set("error", params.error);
  if (params.state) url.searchParams.set("state", params.state);
  return url.toString();
}

async function issueTokenPair(grantId: string, resource: string, scope: string) {
  return insertTokenPair(db, grantId, resource, scope);
}

async function insertTokenPair(
  tx: Pick<typeof db, "insert">,
  grantId: string,
  resource: string,
  scope: string,
) {
  const access = `hoa_${randomBytes(32).toString("base64url")}`;
  const refresh = `hor_${randomBytes(32).toString("base64url")}`;
  const now = Date.now();
  const [row] = await tx
    .insert(oauthTokens)
    .values({
      grantId,
      accessHash: hashToken(access),
      accessPrefix: access.slice(0, 12),
      refreshHash: hashToken(refresh),
      resource,
      scope,
      accessExpiresAt: new Date(now + ACCESS_TTL_SEC * 1000),
      refreshExpiresAt: new Date(now + REFRESH_TTL_SEC * 1000),
    })
    .returning();
  if (!row) throw new Error("Failed to issue a token");
  return {
    access_token: access,
    token_type: "Bearer" as const,
    expires_in: ACCESS_TTL_SEC,
    refresh_token: refresh,
    scope,
  };
}

async function liveGrant(grantId: string) {
  const [grant] = await db.select().from(oauthGrants).where(eq(oauthGrants.id, grantId)).limit(1);
  if (!grant || grant.revokedAt) return null;
  return grant;
}

async function loadOpenRequest(requestId: string) {
  const [row] = await db.select().from(oauthRequests).where(eq(oauthRequests.id, requestId)).limit(1);
  if (!row || row.consumedAt) throw new HttpError(400, "invalid_request", "That connection request is no longer open.");
  if (row.expiresAt.getTime() <= Date.now()) {
    throw new HttpError(400, "invalid_request", "That connection request has expired. Start the install again.");
  }
  return row;
}

async function assertOwnerOfTeams(userId: string, teamIds: string[]) {
  const rows = await db
    .select({ teamId: memberships.teamId, role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), inArray(memberships.teamId, teamIds)));
  const owned = new Set(rows.filter((row) => row.role === "owner").map((row) => row.teamId));
  if (teamIds.some((teamId) => !owned.has(teamId))) {
    throw new HttpError(403, "forbidden", "Only an owner can connect that list.");
  }
}

async function findClient(clientId: string) {
  const [row] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1);
  return row ?? null;
}

function isMetadataClientId(clientId: string) {
  if (!clientId.startsWith("https://") || clientId.length > 2048) return false;
  try {
    const url = new URL(clientId);
    return url.protocol === "https:" && url.pathname.length > 1 && !url.username && !url.hash;
  } catch {
    return false;
  }
}

async function loadMetadataClient(clientId: string) {
  const existing = await findClient(clientId);
  if (
    existing?.source === "cimd" &&
    existing.metadataFetchedAt &&
    Date.now() - existing.metadataFetchedAt.getTime() < CIMD_CACHE_MS
  ) {
    return existing;
  }
  const document = await fetchMetadataDocument(clientId);
  const fetchedAt = new Date();
  if (existing) {
    const [updated] = await db
      .update(oauthClients)
      .set({
        clientName: document.client_name,
        redirectUris: document.redirect_uris,
        metadataFetchedAt: fetchedAt,
        source: "cimd",
      })
      .where(eq(oauthClients.id, existing.id))
      .returning();
    return updated ?? existing;
  }
  const [created] = await db
    .insert(oauthClients)
    .values({
      clientId,
      clientName: document.client_name,
      redirectUris: document.redirect_uris,
      tokenEndpointAuthMethod: "none",
      source: "cimd",
      metadataFetchedAt: fetchedAt,
    })
    .returning();
  if (!created) throw new OAuthError(400, "invalid_client", "Could not store that client.");
  return created;
}

async function fetchMetadataDocument(clientId: string) {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new OAuthError(400, "invalid_client", "client_id is not a metadata URL.");
  }
  if (isBlockedHost(url.hostname)) {
    throw new OAuthError(400, "invalid_client", "That client metadata host is not allowed.");
  }
  const records = await lookup(url.hostname, { all: true, verbatim: true }).catch(() => []);
  if (records.length === 0 || records.some((record) => isBlockedHost(record.address))) {
    throw new OAuthError(400, "invalid_client", "That client metadata host is not allowed.");
  }
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(4000),
    headers: { accept: "application/json", "user-agent": "hearth-oauth" },
  }).catch(() => null);
  if (!response || response.status !== 200) {
    throw new OAuthError(400, "invalid_client", "Could not read that client metadata document.");
  }
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > 65536) throw new OAuthError(400, "invalid_client", "That client metadata document is too large.");
  const text = await response.text();
  if (text.length > 65536) throw new OAuthError(400, "invalid_client", "That client metadata document is too large.");
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    throw new OAuthError(400, "invalid_client", "Client metadata was not JSON.");
  }
  const parsed = cimdSchema.safeParse(json);
  if (!parsed.success || parsed.data.client_id !== clientId) {
    throw new OAuthError(400, "invalid_client", "Client metadata did not match the client_id.");
  }
  if (parsed.data.token_endpoint_auth_method && parsed.data.token_endpoint_auth_method !== "none") {
    throw new OAuthError(400, "invalid_client", "This server only accepts public clients.");
  }
  if (parsed.data.redirect_uris.some((uri) => !isAllowedRedirect(uri))) {
    throw new OAuthError(400, "invalid_client", "That client metadata lists a redirect URI this server does not allow.");
  }
  return parsed.data;
}

function isBlockedHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal"
  ) {
    return true;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const parts = [v4[1], v4[2], v4[3], v4[4]].map((part) => Number(part));
    if (parts.some((part) => part > 255)) return true;
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (!host.includes(":")) return false;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (host.startsWith("::ffff:")) return isBlockedHost(host.slice("::ffff:".length));
  const head = host.split(":")[0] ?? "";
  return head.startsWith("fe80") || head.startsWith("fc") || head.startsWith("fd");
}
