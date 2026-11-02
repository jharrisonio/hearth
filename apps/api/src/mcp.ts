import {
  cancelTaskSchema,
  cancelTaskToolSchema,
  completeTaskToolSchema,
  createAreaSchema,
  createAreaToolSchema,
  createProjectSchema,
  createProjectToolSchema,
  createTaskSchema,
  createTaskToolSchema,
  deleteTaskToolSchema,
  doImmediatelyQuerySchema,
  httpOperations,
  IDEMPOTENCY_KEY_HEADER,
  listBotsToolSchema,
  listNamedToolSchema,
  listTasksQuerySchema,
  registerBotSchema,
  registerBotToolSchema,
  unregisterBotToolSchema,
  updateProjectSchema,
  updateProjectToolSchema,
  updateTaskSchema,
  updateTaskToolSchema,
  type ListNamedToolInput,
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
        "Hearth tasks for the team this bot token belongs to. Pass idempotencyKey on create_task when a retry must return the original task instead of a duplicate. The key lasts 24 hours for this bot. A project is a multi-step outcome; an area is a life or work domain such as House or Finance. Link them with projectId and areaId. On a project, do_now, delegate, and schedule are active next actions and several may run at once. Future or dependent steps are separate tasks with action later. Project notes hold the plan, not the step list. Later steps stay out of list_do_immediately. Register Fin, Rally, and other agents with register_bot (agent id and display name, no extra token) and set owner to that bot id. waitingOn is required on a delegate task unless the owner is a bot. list_do_immediately for this token is open delegate tasks this token owns, plus schedule tasks this token owns that still need a calendar or are overdue. Another registered bot's delegate work is list_tasks with action=delegate, status=open, and owner=bot:<id>. Set source to { type: \"email\" | \"url\", href, label?, externalId? } to link the originating email or page. For Gmail, href is https://mail.google.com/mail/u/0/#all/<threadId> and externalId is the message or thread id. Pass source: null on update_task to clear it. cancel_task keeps the row for audit. delete_task removes a mistake or duplicate. Live edits are not pushed over MCP. Subscribe with GET /teams/:teamId/events (text/event-stream, same Bearer token). Read the hearth://task-events resource for the exact URL and the event shape.",
    },
  );
  registerTaskTools(server, app, authorization ?? "");
  registerTaskEventsResource(server, app, authorization ?? "");

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

function registerTaskEventsResource(server: McpServer, app: FetchApp, authorization: string) {
  server.registerResource(
    "task-events",
    "hearth://task-events",
    {
      description:
        "How to subscribe to live task changes for this bot. Server-sent events on the REST API, not an MCP stream.",
      mimeType: "text/plain",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/plain",
          text: await taskEventsText(app, authorization),
        },
      ],
    }),
  );
}

async function taskEventsText(app: FetchApp, authorization: string) {
  const listed = await callApi(app, authorization, "/teams");
  const teams =
    listed.status < 400 ? ((listed.body as { teams?: { id: string }[] } | null)?.teams ?? []) : [];
  const urls = teams.length
    ? teams.map((team) => `GET /teams/${team.id}/events`).join("\n")
    : httpOperations.taskEvents.path;
  return [
    "Live task changes are server-sent events, not an MCP stream.",
    "Send the same Authorization: Bearer token and Accept: text/event-stream.",
    urls,
    "Through the web origin, prefix the path with /api.",
    "The event name is created, updated, completed, cancelled, or deleted. data is JSON with type, teamId, taskId, at, and task (the same task object as GET /tasks, including source).",
    "On deleted, task is that row on the process that removed it, and null on another process because the row is already gone. taskId is enough to drop it.",
    "event ready means the subscription is on. Lines starting with ':' are keepalives. event reconnect means open the URL again and refetch with list_tasks.",
    "There is no backlog. An idempotent replay does not emit another created event.",
  ].join("\n");
}

function registerTaskTools(server: McpServer, app: FetchApp, authorization: string) {
  server.registerTool(
    "create_task",
    {
      description:
        "Create one task (POST /tasks), one project step per call. Active next actions are action do_now, delegate, or schedule — several may share a project. Future or dependent steps use action later unless that step is explicitly active. Omit action to take the important × urgent suggestion (neither suggests later). idempotencyKey is sent as the Idempotency-Key header. The same key and body, for this bot, returns the original task for 24 hours. A different body with that key is rejected. owner, when type bot, must be a bot registered on the team (or an existing token id). waitingOn is required when action is delegate and the owner is not a bot. A bot owner may omit waitingOn. Omit owner and this token becomes the owner. projectId and areaId link a project or an area on the same team. source, when set, is { type: \"email\" | \"url\", href, label?, externalId? }. href is an http(s) URL. For Gmail, type is email and href is the mail.google.com deep link.",
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
        "Update a task (PATCH /tasks/:id). Set action to move a project step between an active front (do_now, delegate, schedule) and later. Several active fronts on one project are allowed. Status cannot be changed here. Complete the task with complete_task, or cancel it with cancel_task. owner, when type bot, must be a bot registered on the team (or an existing token id). waitingOn is required when the task is delegate and the owner is not a bot. A bot owner may set waitingOn to null. Pass projectId or areaId as a uuid to set that link, or null to clear it. Omit either field to leave it unchanged. source replaces the link; null clears it. Omit source to leave the link unchanged.",
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
    "cancel_task",
    {
      description:
        'Cancel a task and keep the row (POST /tasks/:id/cancel). Optional outcome; the default is "cancelled". The task leaves open lists and the morning queue. Emits a cancelled event.',
      inputSchema: cancelTaskToolSchema,
    },
    async ({ id, outcome }) => {
      const parsed = cancelTaskSchema.parse(outcome === undefined ? {} : { outcome });
      return asTool(await callApi(app, authorization, `/tasks/${id}/cancel`, {
        method: httpOperations.cancelTask.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed),
      }));
    },
  );

  server.registerTool(
    "delete_task",
    {
      description:
        "Permanently delete a task (DELETE /tasks/:id). For a mistake or a duplicate. Emits a deleted event. The row is gone, and an Idempotency-Key that pointed at it can be used again.",
      inputSchema: deleteTaskToolSchema,
    },
    async ({ id }) =>
      asTool(await callApi(app, authorization, `/tasks/${id}`, { method: httpOperations.deleteTask.method })),
  );

  server.registerTool(
    "list_tasks",
    {
      description:
        "List tasks (GET /tasks). Each task includes action, source (an email or url link, or null), plus project and area when set. Filter projectId together with action to separate a project's active steps (do_now, delegate, schedule) from later support steps. A bot's open delegate work is action=delegate, status=open, and owner=bot:<uuid>. Other filters: teamId, status (open, done, or cancelled), important, urgent, owner (user:<uuid> or bot:<uuid>), dueBefore, areaId, mine. Omit teamId to use this bot's team. status=open hides cancelled tasks. status=cancelled is the audit list.",
      inputSchema: listTasksQuerySchema,
    },
    async (query) => asTool(await callApi(app, authorization, `${httpOperations.listTasks.path}${queryString(query)}`)),
  );

  server.registerTool(
    "list_do_immediately",
    {
      description:
        "Open work for the caller (GET /tasks/do-immediately). This token receives open delegate tasks it owns, plus schedule tasks it owns that still need a calendar or are overdue. It does not include do_now or another bot's tasks. A human receives the morning queue: open do_now, schedule that still needs a calendar or is overdue, and overdue delegate follow-ups whose owner is not a bot. Done, cancelled, and action later stay out, including future steps on a project. Optional teamId.",
      inputSchema: doImmediatelyQuerySchema,
    },
    async (query) =>
      asTool(await callApi(app, authorization, `${httpOperations.listDoImmediately.path}${queryString(query)}`)),
  );

  server.registerTool(
    "create_project",
    {
      description:
        "Create a project (POST /teams/:id/projects). A project is a multi-step outcome, not a life area. notes is an optional plan. Steps are tasks with that projectId. The same name returns the existing project, restores it if archived, and replaces notes when notes is sent. Omit teamId when this token belongs to one team.",
      inputSchema: createProjectToolSchema,
    },
    async ({ teamId, ...body }) => {
      const resolved = await resolveTeamId(app, authorization, teamId);
      if ("failure" in resolved) return asTool(resolved.failure);
      const parsed = createProjectSchema.parse(body);
      return asTool(await callApi(app, authorization, `/teams/${resolved.teamId}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed),
      }));
    },
  );

  server.registerTool(
    "update_project",
    {
      description:
        "Update a project (PATCH /teams/:id/projects/:id). Change name, notes, areaId, or archived. Null notes clears the plan. Null areaId clears the area. archived true completes the project and is rejected while any task on it is still open. Steps stay tasks. Omit teamId when this token belongs to one team.",
      inputSchema: updateProjectToolSchema,
    },
    async ({ id, teamId, ...patch }) => {
      const resolved = await resolveTeamId(app, authorization, teamId);
      if ("failure" in resolved) return asTool(resolved.failure);
      const parsed = updateProjectSchema.parse(patch);
      return asTool(await callApi(app, authorization, `/teams/${resolved.teamId}/projects/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed),
      }));
    },
  );

  server.registerTool(
    "list_projects",
    {
      description:
        "List projects (GET /teams/:id/projects), each with notes and area. A project is a multi-step outcome; its steps are tasks. Archived projects are omitted unless includeArchived is true. Omit teamId when this token belongs to one team.",
      inputSchema: listNamedToolSchema,
    },
    async (query) => {
      const resolved = await resolveTeamId(app, authorization, query.teamId);
      if ("failure" in resolved) return asTool(resolved.failure);
      return asTool(await callApi(app, authorization, `/teams/${resolved.teamId}/projects${namedQuery(query)}`));
    },
  );

  server.registerTool(
    "create_area",
    {
      description:
        "Create an area on a team (POST /teams/:id/areas). An area is a life or work domain, such as House or Finance, not a project. The same name returns the existing area and restores it if it was archived. Omit teamId when this token belongs to one team.",
      inputSchema: createAreaToolSchema,
    },
    async ({ teamId, name }) => {
      const resolved = await resolveTeamId(app, authorization, teamId);
      if ("failure" in resolved) return asTool(resolved.failure);
      const parsed = createAreaSchema.parse({ name });
      return asTool(await callApi(app, authorization, `/teams/${resolved.teamId}/areas`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed),
      }));
    },
  );

  server.registerTool(
    "list_areas",
    {
      description:
        "List areas on a team (GET /teams/:id/areas). Archived areas are omitted unless includeArchived is true. Omit teamId when this token belongs to one team.",
      inputSchema: listNamedToolSchema,
    },
    async (query) => {
      const resolved = await resolveTeamId(app, authorization, query.teamId);
      if ("failure" in resolved) return asTool(resolved.failure);
      return asTool(await callApi(app, authorization, `/teams/${resolved.teamId}/areas${namedQuery(query)}`));
    },
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

function namedQuery(query: ListNamedToolInput) {
  return query.includeArchived ? "?includeArchived=true" : "";
}

function queryString(query: ListTasksQuery | { teamId?: string }) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}
