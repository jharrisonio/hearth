import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import { safeNextPath } from "@hearth/shared";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://hearth:hearth@127.0.0.1:5432/hearth_test";
if (!/\/hearth_test(\?|$)/.test(databaseUrl)) {
  throw new Error("Refusing to run: DATABASE_URL must use the hearth_test database.");
}
process.env.DATABASE_URL = databaseUrl;
process.env.SESSION_SECRET ??= "test-session-secret-value";
process.env.OAUTH_ISSUER = "http://127.0.0.1:43124";
process.env.PUBLIC_URL = "http://127.0.0.1:43123";

const { createApp } = await import("./app.js");
const { db, pool, runMigrations } = await import("./db.js");
const { signSession } = await import("./actor.js");
const { isAllowedRedirect, parseAgentRoster, pkceMatches, pkceS256, redirectMatches } = await import("./oauth.js");
const { bots, memberships, tasks, teams, users } = await import("./schema.js");
const { mintToken } = await import("./tokens.js");
const { eq } = await import("drizzle-orm");

const app = createApp();
const issuer = process.env.OAUTH_ISSUER;
const sessionSecret = process.env.SESSION_SECRET;

describe("mcp oauth", { concurrency: 1 }, () => {
  before(async () => {
    await runMigrations();
    const tables = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_name like 'oauth_%'`,
    );
    const names = new Set(tables.rows.map((row) => row.table_name));
    for (const name of ["oauth_clients", "oauth_requests", "oauth_grants", "oauth_grant_teams", "oauth_codes", "oauth_tokens"]) {
      assert.equal(names.has(name), true, name);
    }
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE TABLE users, teams, memberships, bot_tokens, bots, projects, areas, tasks, idempotency_keys, oauth_clients, oauth_requests, oauth_grants, oauth_grant_teams, oauth_codes, oauth_tokens RESTART IDENTITY CASCADE",
    );
  });

  after(async () => {
    await pool.end();
  });

  test("discovery, PKCE helpers, and redirect rules", async () => {
    assert.equal(safeNextPath("/oauth/consent?request=abc"), "/oauth/consent?request=abc");
    assert.equal(safeNextPath("https://evil.example"), null);
    assert.equal(safeNextPath("//evil.example"), null);
    assert.equal(isAllowedRedirect("cursor://anysphere.cursor-mcp/oauth/callback"), true);
    assert.equal(isAllowedRedirect("grokbot://mcp/oauth/callback"), true);
    assert.equal(isAllowedRedirect("cursor://elsewhere/oauth/callback"), false);
    assert.equal(isAllowedRedirect("http://evil.example/callback"), false);
    assert.equal(isAllowedRedirect("http://127.0.0.1:8787/callback"), true);
    assert.equal(
      redirectMatches(["http://localhost:8787/callback"], "http://localhost:9999/callback"),
      true,
    );
    assert.deepEqual(parseAgentRoster("not-json"), []);
    const verifier = randomBytes(32).toString("base64url");
    assert.equal(pkceMatches(verifier, pkceS256(verifier)), true);
    assert.equal(pkceMatches(verifier, pkceS256("other")), false);

    const resource = await app.request("/.well-known/oauth-protected-resource");
    assert.equal(resource.status, 200);
    const resourceBody = (await resource.json()) as { resource: string; authorization_servers: string[]; scopes_supported: string[] };
    assert.equal(resourceBody.resource, `${issuer}/mcp`);
    assert.deepEqual(resourceBody.authorization_servers, [issuer]);
    assert.deepEqual(resourceBody.scopes_supported, ["hearth"]);

    const pathResource = await app.request("/.well-known/oauth-protected-resource/mcp");
    assert.equal(pathResource.status, 200);
    const server = await app.request("/.well-known/oauth-authorization-server");
    assert.equal(server.status, 200);
    const metadata = (await server.json()) as {
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
      code_challenge_methods_supported: string[];
      client_id_metadata_document_supported: boolean;
    };
    assert.equal(metadata.issuer, issuer);
    assert.equal(metadata.authorization_endpoint, `${issuer}/authorize`);
    assert.equal(metadata.token_endpoint, `${issuer}/token`);
    assert.equal(metadata.registration_endpoint, `${issuer}/register`);
    assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
    assert.equal(metadata.client_id_metadata_document_supported, true);
    const oidc = await app.request("/.well-known/openid-configuration");
    assert.equal(oidc.status, 200);

    const anon = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(anon.status, 401);
    const challenge = anon.headers.get("www-authenticate") ?? "";
    assert.match(challenge, /resource_metadata="http:\/\/127\.0\.0\.1:43124\/\.well-known\/oauth-protected-resource"/);
    assert.match(challenge, /scope="hearth"/);
    assert.equal(challenge.includes("invalid_token"), false);
  });

  test("a client consents to lists, calls MCP, and refreshes", async () => {
    const fixture = await seed();
    const redirectUri = "http://127.0.0.1:8787/callback";
    const registered = await register([redirectUri, "cursor://anysphere.cursor-mcp/oauth/callback", "https://www.cursor.com/agents/mcp/oauth/callback"]);
    const bad = await register(["http://evil.example/callback"]);
    assert.equal(bad.status, 400);
    assert.equal((bad.json as { error: string }).error, "invalid_client_metadata");

    const { verifier, challenge } = pkce();
    const agents = encodeURIComponent(JSON.stringify([{ agentId: "grok-fin", name: "Fin" }]));
    const start = await app.request(
      `/authorize?response_type=code&client_id=${registered.client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz&resource=${encodeURIComponent(`${issuer}/mcp`)}&agents=${agents}`,
    );
    assert.equal(start.status, 302);
    const consentUrl = new URL(start.headers.get("location") ?? "");
    assert.equal(consentUrl.origin, "http://127.0.0.1:43123");
    assert.equal(consentUrl.pathname, "/oauth/consent");
    const requestId = consentUrl.searchParams.get("request");
    assert.ok(requestId);

    const preview = await app.request(`/oauth/request?request=${requestId}`);
    assert.equal(preview.status, 200);
    const previewBody = (await preview.json()) as { clientName: string; agents: { agentId: string }[]; redirectHost: string };
    assert.equal(previewBody.clientName, "Grok Bot");
    assert.equal(previewBody.redirectHost, "127.0.0.1:8787");
    assert.deepEqual(previewBody.agents.map((agent) => agent.agentId), ["grok-fin"]);

    const stranger = await seedUser("Naomi");
    await db.insert(memberships).values({ teamId: fixture.home.id, userId: stranger.id, role: "member" });
    const deniedMember = await app.request("/oauth/consent", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieFor(stranger.id) },
      body: JSON.stringify({ request: requestId, teamIds: [fixture.home.id], bots: previewBody.agents }),
    });
    assert.equal(deniedMember.status, 403);

    const approved = await app.request("/oauth/consent", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieFor(fixture.user.id) },
      body: JSON.stringify({
        request: requestId,
        teamIds: [fixture.home.id, fixture.personal.id],
        bots: [{ agentId: "grok-fin", name: "Fin" }],
      }),
    });
    assert.equal(approved.status, 200);
    const redirectTo = new URL(((await approved.json()) as { redirectTo: string }).redirectTo);
    assert.equal(redirectTo.origin, "http://127.0.0.1:8787");
    assert.equal(redirectTo.searchParams.get("state"), "xyz");
    const code = redirectTo.searchParams.get("code");
    assert.ok(code);

    const wrong = await token({
      grant_type: "authorization_code",
      code: code ?? "",
      client_id: registered.client_id,
      redirect_uri: redirectUri,
      code_verifier: "not-the-verifier-not-the-verifier-not-the-verifier",
    });
    assert.equal(wrong.status, 400);

    const issued = await token({
      grant_type: "authorization_code",
      code: code ?? "",
      client_id: registered.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: `${issuer}/mcp`,
    });
    assert.equal(issued.status, 200);
    const access = issued.json as { access_token: string; refresh_token: string; token_type: string; expires_in: number };
    assert.equal(access.token_type, "Bearer");
    assert.ok(access.access_token.startsWith("hoa_"));
    assert.ok(access.refresh_token.startsWith("hor_"));
    assert.equal(access.expires_in, 3600);

    const reused = await token({
      grant_type: "authorization_code",
      code: code ?? "",
      client_id: registered.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    assert.equal(reused.status, 400);
    const dead = await rpc(access.access_token, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "hearth-test", version: "0" },
    });
    assert.equal(dead.status, 401);

    const again = await install(fixture, redirectUri);
    const homeTask = await rpc(again.access, "tools/call", {
      name: "create_task",
      arguments: { teamId: fixture.home.id, title: "Oat milk", action: "do_now", important: true, urgent: true },
    });
    assert.equal(homeTask.status, 200);
    const created = toolJson(homeTask.json) as { id: string; owner: { type: string; id: string }; teamId: string };
    assert.equal(created.teamId, fixture.home.id);
    assert.equal(created.owner.type, "bot");
    const connectors = await app.request(`/teams/${fixture.home.id}/connectors`, { headers: { cookie: cookieFor(fixture.user.id) } });
    const connector = ((await connectors.json()) as { connectors: { id: string; clientName: string }[] }).connectors[0];
    assert.ok(connector);
    assert.equal(connector.clientName, "Grok Bot");
    assert.equal(created.owner.id, connector.id);

    const personalTask = await rpc(again.access, "tools/call", {
      name: "create_task",
      arguments: { teamId: fixture.personal.id, title: "Personal note", action: "later" },
    });
    assert.equal(personalTask.status, 200);
    const other = await rpc(again.access, "tools/call", {
      name: "create_task",
      arguments: { teamId: fixture.other.id, title: "Nope" },
    });
    const otherResult = rpcResult(other.json) as { isError?: boolean; content?: { text: string }[] };
    assert.equal(otherResult.isError, true);
    assert.match(otherResult.content?.[0]?.text ?? "", /403/);

    const listed = await rpc(again.access, "tools/list");
    const names = ((rpcResult(listed.json) as { tools: { name: string }[] }).tools).map((tool) => tool.name);
    assert.equal(names.includes("register_bot"), false);
    assert.equal(names.includes("list_bots"), false);

    const botRows = await db.select().from(bots).where(eq(bots.teamId, fixture.home.id));
    assert.equal(botRows.length, 1);
    assert.equal(botRows[0]?.name, "Fin");
    const renamed = await app.request(`/teams/${fixture.home.id}/bots/${botRows[0]?.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: cookieFor(fixture.user.id) },
      body: JSON.stringify({ name: "Finley" }),
    });
    assert.equal(renamed.status, 200);
    const taskRow = await db.select().from(tasks).where(eq(tasks.id, created.id));
    assert.equal(taskRow[0]?.ownerId, connector.id);

    const legacy = await rpc(fixture.secret, "tools/call", {
      name: "list_tasks",
      arguments: { teamId: fixture.home.id },
    });
    assert.equal(legacy.status, 200);
    assert.equal(toolJson(legacy.json) !== null, true);

    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: again.refresh,
      client_id: again.clientId,
      resource: `${issuer}/mcp`,
    });
    assert.equal(refreshed.status, 200);
    const next = refreshed.json as { access_token: string; refresh_token: string };
    assert.notEqual(next.access_token, again.access);
    const still = await rpc(next.access_token, "tools/call", {
      name: "list_tasks",
      arguments: { teamId: fixture.personal.id },
    });
    assert.equal(still.status, 200);

    const reuse = await token({
      grant_type: "refresh_token",
      refresh_token: again.refresh,
      client_id: again.clientId,
    });
    assert.equal(reuse.status, 400);
    const revoked = await rpc(next.access_token, "tools/call", { name: "list_tasks", arguments: {} });
    assert.equal(revoked.status, 401);
    assert.match(revoked.challenge, /invalid_token/);
  });

  test("disconnecting a list drops it without a new token", async () => {
    const fixture = await seed();
    const redirectUri = "https://www.cursor.com/agents/mcp/oauth/callback";
    const installed = await install(fixture, redirectUri);
    const one = await app.request(`/teams/${fixture.home.id}/connectors/${installed.grantId}`, {
      method: "DELETE",
      headers: { cookie: cookieFor(fixture.user.id) },
    });
    assert.equal(one.status, 200);
    assert.equal(((await one.json()) as { grantRevoked: boolean }).grantRevoked, false);
    const home = await rpc(installed.access, "tools/call", {
      name: "list_tasks",
      arguments: { teamId: fixture.home.id },
    });
    assert.match((rpcResult(home.json) as { content?: { text: string }[] }).content?.[0]?.text ?? "", /403/);
    const personal = await rpc(installed.access, "tools/call", {
      name: "list_tasks",
      arguments: { teamId: fixture.personal.id },
    });
    assert.equal((rpcResult(personal.json) as { isError?: boolean }).isError, undefined);

    const rest = await app.request(`/teams/${fixture.personal.id}/connectors/${installed.grantId}`, {
      method: "DELETE",
      headers: { cookie: cookieFor(fixture.user.id) },
    });
    assert.equal(((await rest.json()) as { grantRevoked: boolean }).grantRevoked, true);
    const gone = await rpc(installed.access, "tools/call", { name: "list_tasks", arguments: {} });
    assert.equal(gone.status, 401);
  });
});

async function install(
  fixture: { user: { id: string }; home: { id: string }; personal: { id: string } },
  redirectUri: string,
) {
  const registered = await register([redirectUri]);
  const { verifier, challenge } = pkce();
  const start = await app.request(
    `/authorize?response_type=code&client_id=${registered.client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256&state=s1&resource=${encodeURIComponent(`${issuer}/mcp`)}&agents=${encodeURIComponent(JSON.stringify([{ agentId: "grok-fin", name: "Fin" }]))}`,
  );
  const requestId = new URL(start.headers.get("location") ?? "").searchParams.get("request");
  const approved = await app.request("/oauth/consent", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookieFor(fixture.user.id) },
    body: JSON.stringify({
      request: requestId,
      teamIds: [fixture.home.id, fixture.personal.id],
      bots: [{ agentId: "grok-fin", name: "Fin" }],
    }),
  });
  const redirectTo = new URL(((await approved.json()) as { redirectTo: string }).redirectTo);
  const issued = await token({
    grant_type: "authorization_code",
    code: redirectTo.searchParams.get("code") ?? "",
    client_id: registered.client_id,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const body = issued.json as { access_token: string; refresh_token: string };
  const connectors = await app.request(`/teams/${fixture.home.id}/connectors`, {
    headers: { cookie: cookieFor(fixture.user.id) },
  });
  const grantId = ((await connectors.json()) as { connectors: { id: string }[] }).connectors[0]?.id ?? "";
  return { access: body.access_token, refresh: body.refresh_token, clientId: registered.client_id, grantId };
}

async function register(redirectUris: string[]) {
  const response = await app.request("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Grok Bot",
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const text = await response.text();
  const json = (text ? JSON.parse(text) : null) as { client_id?: string } | null;
  return { status: response.status, json, client_id: json?.client_id ?? "" };
}

async function token(fields: Record<string, string>) {
  const response = await app.request("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as unknown) : null };
}

async function seed() {
  const user = await seedUser("James");
  const [home] = await db.insert(teams).values({ name: "Harrison", kind: "household" }).returning();
  const [personal] = await db.insert(teams).values({ name: "James's list", kind: "personal" }).returning();
  const [other] = await db.insert(teams).values({ name: "Naomi", kind: "personal" }).returning();
  if (!home || !personal || !other) throw new Error("seed failed");
  await db.insert(memberships).values([
    { teamId: home.id, userId: user.id, role: "owner" },
    { teamId: personal.id, userId: user.id, role: "owner" },
  ]);
  const minted = mintToken();
  const { botTokens } = await import("./schema.js");
  await db.insert(botTokens).values({
    teamId: home.id,
    label: "legacy",
    tokenHash: minted.hash,
    tokenPrefix: minted.prefix,
    createdByUserId: user.id,
  });
  return { user, home, personal, other, secret: minted.secret };
}

async function seedUser(name: string) {
  const [user] = await db
    .insert(users)
    .values({ email: `${name.toLowerCase()}-${crypto.randomUUID()}@example.com`, name })
    .returning();
  if (!user) throw new Error("user seed failed");
  return user;
}

function cookieFor(userId: string) {
  return `hearth_session=${signSession(userId, sessionSecret, 3600)}`;
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function rpc(tokenValue: string, method: string, params?: unknown) {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${tokenValue}`,
      ...(method === "initialize" ? {} : { "mcp-protocol-version": "2025-03-26" }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? (JSON.parse(text) as unknown) : null,
    challenge: response.headers.get("www-authenticate") ?? "",
  };
}

function rpcResult(json: unknown) {
  return (json as { result?: unknown }).result as { isError?: boolean; content?: { text?: string }[]; tools?: { name: string }[] };
}

function toolJson(json: unknown) {
  const result = rpcResult(json);
  assert.notEqual(result?.isError, true, result?.content?.[0]?.text);
  return JSON.parse(result?.content?.[0]?.text ?? "null") as unknown;
}
