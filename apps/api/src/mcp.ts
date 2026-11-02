import {
  completeTaskToolSchema,
  createTaskSchema,
  createTaskToolSchema,
  doImmediatelyQuerySchema,
  httpOperations,
  IDEMPOTENCY_KEY_HEADER,
  listBotsToolSchema,
  listTasksQuerySchema,
  registerBotSchema,
  registerBotToolSchema,
  unregisterBotToolSchema,
  updateTaskSchema,
  updateTaskToolSchema,
  type ListTasksQuery,
} from "@hearth/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Context } from "hono";
import { actorFromBearer } from "./actor.js";

type FetchApp = {
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
};

type ApiResult = { status: number; body: unknown };
type TeamResolution = { teamId: string } | { failure: ApiResult };

const SERVER_VERSION = "0.1.0";

/**
 * Stateless Streamable HTTP on POST /mcp. JSON responses, no SSE stream.
 * Every request needs the same bot Bearer token as the REST API. Tools call
 * the task routes in-process, so validation and idempotency stay in one place.
 */
export async function handleMcp(c: Context, app: FetchApp): Promise<Response> {
  const authorization = c.req.header("authorization");
  await actorFromBearer(authorization);

  const server = new McpServer(
    { name: "hearth", version: SERVER_VERSION },
    {
      instructions:
        "Hearth tasks for the team this bot token belongs to. Pass idempotencyKey on create_task when a retry must return the original task instead of a duplicate. The key lasts 24 hours for this bot. Register Fin, Rally, and other agents with register_bot (agent id and display name, no extra token) and set owner to that bot id.",
    },
  );
  registerTaskTools(server, app, authorization ?? "");

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(c.req.raw);
  } finally {
    await server.close();
  }
}

function registerTaskTools(server: McpServer, app: FetchApp, authorization: string) {
  server.registerTool(
    "create_task",
    {
      description:
        "Create a task (POST /tasks). idempotencyKey is sent as the Idempotency-Key header. The same key and body, for this bot, returns the original task for 24 hours. A different body with that key is rejected. owner, when type bot, must be a bot registered on the team (or an existing token id).",
      inputSchema: createTaskToolSchema,
    },
    async ({ idempotencyKey, ...body }) => {
      const parsed = createTaskSchema.parse(body);
      const headers = new Headers({ "content-type": "application/json" });
      if (idempotencyKey) headers.set(IDEMPOTENCY_KEY_HEADER, idempotencyKey);
      return asTool(await callApi(app, authorization, httpOperations.createTask.path, {
        method: httpOperations.createTask.method,
        headers,
        body: JSON.stringify(parsed),
      }));
    },
  );

  server.registerTool(
    "update_task",
    {
      description:
        "Update a task (PATCH /tasks/:id). Status cannot be changed here. Complete the task with complete_task. owner, when type bot, must be a bot registered on the team (or an existing token id).",
      inputSchema: updateTaskToolSchema,
    },
    async ({ id, ...patch }) => {
      const parsed = updateTaskSchema.parse(patch);
      return asTool(await callApi(app, authorization, `/tasks/${id}`, {
        method: httpOperations.updateTask.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed),
      }));
    },
  );

  server.registerTool(
    "complete_task",
    {
      description: "Mark a task done and record what happened (POST /tasks/:id/complete).",
      inputSchema: completeTaskToolSchema,
    },
    async ({ id, outcome }) =>
      asTool(await callApi(app, authorization, `/tasks/${id}/complete`, {
        method: httpOperations.completeTask.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outcome }),
      })),
  );

  server.registerTool(
    "list_tasks",
    {
      description:
        "List tasks (GET /tasks). Filters: teamId, action (do_now, delegate, schedule, later), status (open or done), important, urgent, owner (user:<uuid> or bot:<uuid>), dueBefore, project, mine. Omit teamId to use this bot's team.",
      inputSchema: listTasksQuerySchema,
    },
    async (query) => asTool(await callApi(app, authorization, `${httpOperations.listTasks.path}${queryString(query)}`)),
  );

  server.registerTool(
    "list_do_immediately",
    {
      description:
        "Morning queue (GET /tasks/do-immediately): open do_now tasks, schedule tasks that still need a calendar or are overdue, and delegate follow-ups that are due. Optional teamId.",
      inputSchema: doImmediatelyQuerySchema,
    },
    async (query) =>
      asTool(await callApi(app, authorization, `${httpOperations.listDoImmediately.path}${queryString(query)}`)),
  );

  server.registerTool(
    "register_bot",
    {
      description:
        "Register a bot on a team (POST /teams/:id/bots). Pass the Grok Bot agent id and a display name. No secret is minted. The same agent id returns the same bot; a new name renames it. Omit teamId when this token belongs to one team. Use the returned id as owner.",
      inputSchema: registerBotToolSchema,
    },
    async ({ teamId, agentId, name }) => {
      const resolved = await resolveTeamId(app, authorization, teamId);
      if ("failure" in resolved) return asTool(resolved.failure);
      const parsed = registerBotSchema.parse({ agentId, name });
      return asTool(await callApi(app, authorization, `/teams/${resolved.teamId}/bots`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed),
      }));
    },
  );

  server.registerTool(
    "list_bots",
    {
      description:
        "List bots registered on a team (GET /teams/:id/bots). These are owners, not tokens. Omit teamId when this token belongs to one team.",
      inputSchema: listBotsToolSchema,
    },
    async ({ teamId }) => {
      const resolved = await resolveTeamId(app, authorization, teamId);
      if ("failure" in resolved) return asTool(resolved.failure);
      return asTool(await callApi(app, authorization, `/teams/${resolved.teamId}/bots`));
    },
  );

  server.registerTool(
    "unregister_bot",
    {
      description:
        "Remove a registered bot (DELETE /teams/:id/bots/:id). Existing tasks keep the old owner id. Omit teamId when this token belongs to one team.",
      inputSchema: unregisterBotToolSchema,
    },
    async ({ id, teamId }) => {
      const resolved = await resolveTeamId(app, authorization, teamId);
      if ("failure" in resolved) return asTool(resolved.failure);
      return asTool(await callApi(app, authorization, `/teams/${resolved.teamId}/bots/${id}`, { method: "DELETE" }));
    },
  );
}

async function resolveTeamId(
  app: FetchApp,
  authorization: string,
  teamId: string | undefined,
): Promise<TeamResolution> {
  if (teamId) return { teamId };
  const listed = await callApi(app, authorization, "/teams");
  if (listed.status >= 400) return { failure: listed };
  const teams = (listed.body as { teams?: { id: string }[] } | null)?.teams ?? [];
  const only = teams.length === 1 ? teams[0] : undefined;
  if (!only) {
    return {
      failure: {
        status: 400,
        body: { error: { code: "team_required", message: "Pass teamId." } },
      },
    };
  }
  return { teamId: only.id };
}

async function callApi(app: FetchApp, authorization: string, path: string, init?: RequestInit): Promise<ApiResult> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", authorization);
  const response = await app.request(path, { ...init, headers });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = { error: { code: "invalid_response", message: text } };
    }
  }
  return { status: response.status, body };
}

function asTool(result: ApiResult) {
  if (result.status >= 400) {
    const error = result.body as { error?: { code?: string; message?: string } } | null;
    const code = error?.error?.code ?? "error";
    const message = error?.error?.message ?? "Request failed.";
    return {
      isError: true,
      content: [{ type: "text" as const, text: `${result.status} ${code}: ${message}` }],
    };
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(result.body) }] };
}

function queryString(query: ListTasksQuery | { teamId?: string }) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}
