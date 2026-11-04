import {
  cancelTaskSchema,
  cancelTaskToolSchema,
  completeTaskToolSchema,
  createAreaSchema,
  createAreaToolSchema,
  createProjectSchema,
  createProjectToolSchema,
  createTaskSchema,
  addTaskLinkToolSchema,
  createAttachedLinkSchema,
  createTaskToolSchema,
  deleteTaskToolSchema,
  snoozeTaskSchema,
  snoozeTaskToolSchema,
  unsnoozeTaskToolSchema,
  removeTaskLinkToolSchema,
  doImmediatelyQuerySchema,
  httpOperations,
  IDEMPOTENCY_KEY_HEADER,
  listNamedToolSchema,
  listTasksQuerySchema,
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
import { HttpError } from "./errors.js";
import { bearerChallenge } from "./oauth.js";

type FetchApp = {
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
};

type ApiResult = { status: number; body: unknown };
type TeamResolution = { teamId: string } | { failure: ApiResult };

const SERVER_VERSION = "0.1.0";

/**
 * Standing rules for every connected bot. Returned on MCP initialize and from hearth_help.
 * One string, so a client that surfaces instructions and a client that calls the tool get the same text.
 */
const MCP_INSTRUCTIONS = [
  "Standing rules for every connected Hearth bot. Follow them without a pasted brief. hearth_help returns this same text.",
  "Teams. This token only sees lists it was granted. Personal and household never mix: do not copy or mirror a task from one list onto the other. Spare and other work stay out of Hearth unless James says to put that item here.",
  "Actions. Set action to do_now, delegate, schedule, or later. Present those to people as Do now, Delegate, Schedule, and Later. Do not present Important or Urgent as labels. Those flags only sort the queue. Omitting action stores a suggestion from the flags; set the action yourself. do_now is a human owner doing it. delegate is a bot or an outsider. A bot owner has waitingOn null, because the bot is who acts. An outsider needs waitingOn, the person or office you are waiting on. Omit owner and this token becomes the owner. Hand work to another bot with a registered bot id. schedule needs dueAt, the event time, and calendarEventId. Hearth does not create the Google event. Create it with your calendar connector, then PATCH calendarEventId and dueAt. Until calendarEventId is set, needsCalendar stays true. An open schedule with dueAt in the past is a check-in: complete_task, cancel_task, or update dueAt and calendarEventId. later is a future or dependent step. It stays out of both morning queues until the action changes. Bots may snooze a started do_now task instead of scheduling it.",
  "Projects and areas. A project is a multi-step outcome. An area is a life domain such as House or Finance. Link them with projectId and areaId. A task title is one next action, not the whole outcome. On a project, do_now, delegate, and schedule are active next actions and several may run at once. Future steps are separate tasks with action later. Project notes hold the plan, not the step list.",
  "Queues. list_do_immediately follows the caller and matches the implementation. A human morning queue is inMorningQueue: open do_now; open schedule that still needs a calendar or is a check-in (dueAt strictly in the past); and delegate tasks whose owner is not a bot when dueAt is due or overdue, or when dueAt is empty and the task is more than three days old. Bot-owned delegates stay out of that queue. Bot-owned schedule tasks stay in, so a person can attach the calendar or check in. A bot morning queue is inBotQueue: open delegate tasks this token owns, at any dueAt, plus schedule tasks this token owns that still need a calendar or are a check-in. do_now stays on the human queue. Another bot's delegate work is list_tasks with action=delegate, status=open, and owner=bot:<id>. That bot's check-ins use action=schedule, status=open, owner=bot:<id>, and dueBefore now. List the ones that still need a calendar with needsCalendar=true instead of dueBefore.",
  "Capture and finish. Pass idempotencyKey on create_task. It is sent as Idempotency-Key. The same key and body, for this bot, return the original task for 24 hours. A different body with that key is rejected. Prefer a source link when the task came from an email or a page: { type: \"email\" | \"url\", href, label?, externalId? }. href is an http(s) URL. For Gmail, href is https://mail.google.com/mail/u/0/#all/<threadId> and externalId is the message or thread id. Pass source: null on update_task to clear it. When you finish the work, call complete_task in the same turn with a short outcome. cancel_task is a soft cancel and keeps the row, with an outcome (the default is \"cancelled\"). delete_task is a hard delete for a mistake or a duplicate. Archiving a project is rejected while any task on it is still open. Complete or cancel those tasks first.",
  "Details and links. Keep task details to one or two lines. Put page links in Links with a clear title, not in details or source. Source is only where the task came from, such as an email, and its label is the friendly name on that row. When a task involves choosing between options, comparisons, or background research, write a rich page (a Grok Bot Page or canvas, a Drive doc, or a sheet) and attach it with add_task_link and a clear title. Linked Pages may be private to James. When you finish or progress a task that has a linked page, also put the key decision or finding in the task outcome, one short sentence, so other bots can read it without opening the page.",
  "Delegated tasks. When James delegates a task to a bot, the bot does the research. It either writes a short status summary, a few lines, in the task detail, or attaches a small page of what it found, such as a comparison or a shortlist, via Links with a clear title. If James needs to take steps, the bot writes the numbered instructions for him. When a delegated task comes back with information, from a bot or from a person in waitingOn, update it: either complete it with a one-sentence outcome and create a new Do now task for James with the next step (link the page), or update its detail, links, and waitingOn to show where it stands. Bots review their delegated tasks during their morning queue and keep them current.",
  "Bot owners are named when Hearth is connected, or later in Settings. Use a registered bot id as owner. Reconnecting is not required to add, rename, or retire an owner. Live edits are not pushed over MCP. Subscribe with GET /teams/:teamId/events (text/event-stream, same Bearer token). Read the hearth://task-events resource for the exact URL and the event shape.",
].join("\n\n");

/**
 * Stateless Streamable HTTP on POST /mcp. JSON responses, no SSE stream.
 * Every request needs the same bot Bearer token as the REST API. Tools call
 * the task routes in-process, so validation and idempotency stay in one place.
 */
export async function handleMcp(c: Context, app: FetchApp): Promise<Response> {
  const authorization = c.req.header("authorization");
  try {
    await actorFromBearer(authorization);
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) {
      return bearerChallenge(err.message, Boolean(authorization));
    }
    throw err;
  }

  const server = new McpServer(
    { name: "hearth", version: SERVER_VERSION },
    { instructions: MCP_INSTRUCTIONS },
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
    "The event name is created, updated, completed, cancelled, or deleted. data is JSON with type, teamId, taskId, at, and task (the same task object as GET /tasks, including source and links).",
    "On deleted, task is that row on the process that removed it, and null on another process because the row is already gone. taskId is enough to drop it.",
    "event ready means the subscription is on. Lines starting with ':' are keepalives. event reconnect means open the URL again and refetch with list_tasks.",
    "There is no backlog. An idempotent replay does not emit another created event.",
  ].join("\n");
}

function registerTaskTools(server: McpServer, app: FetchApp, authorization: string) {
  server.registerTool(
    "hearth_help",
    {
      description:
        "Return the standing Hearth rules (teams, actions, queues, and how to finish). Same text as the server instructions on initialize. Read-only. Call it when those instructions were not included in the session.",
      annotations: { readOnlyHint: true },
    },
    async () => ({ content: [{ type: "text" as const, text: MCP_INSTRUCTIONS }] }),
  );

  server.registerTool(
    "create_task",
    {
      description:
        "Create one task (POST /tasks), one project step per call. The title is one next action on one team. do_now is a human owner. Present Do now, Delegate, Schedule, or Later, not Important or Urgent. Prefer a source link. Active next actions are action do_now, delegate, or schedule — several may share a project. Future or dependent steps use action later unless that step is explicitly active. Omit action to take the important × urgent suggestion (neither suggests later). idempotencyKey is sent as the Idempotency-Key header. The same key and body, for this bot, returns the original task for 24 hours. A different body with that key is rejected. owner, when type bot, must be a bot registered on the team, this token, or the connector grant. waitingOn is required when action is delegate and the owner is not a bot. A bot owner may omit waitingOn. Omit owner and this token becomes the owner. projectId and areaId link a project or an area on the same team. source, when set, is { type: \"email\" | \"url\", href, label?, externalId? }. href is an http(s) URL. For Gmail, type is email and href is the mail.google.com deep link. calendarEventId is an event id or an http(s) calendar URL. On a schedule task it clears needsCalendar, and dueAt (the event time) is required with it. Hearth does not create the Google event. Create it, then send the id or URL with dueAt.",
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
        "Update a task (PATCH /tasks/:id). Set action to move a project step between an active front (do_now, delegate, schedule) and later. do_now is a human owner. Several active fronts on one project are allowed. Status cannot be changed here. Complete the task with complete_task, or cancel it with cancel_task. owner, when type bot, must be a bot registered on the team, this token, or the connector grant. waitingOn is required when the task is delegate and the owner is not a bot. A bot owner may set waitingOn to null. Pass projectId or areaId as a uuid to set that link, or null to clear it. Omit either field to leave it unchanged. source replaces the link; null clears it. Omit source to leave the link unchanged. calendarEventId sets the event id or calendar URL after you create the Google event, or null to clear it. A schedule task with a calendar event needs dueAt.",
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
      description:
        "Mark a task done and record a short outcome in the same turn you finish the work (POST /tasks/:id/complete). If the task has a linked page, put the key decision or finding in that outcome, one short sentence. The page may be private to James, and other bots cannot open it.",
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
        'Soft-cancel a task and keep the row (POST /tasks/:id/cancel). Optional outcome; the default is "cancelled". The task leaves open lists and the morning queue. Emits a cancelled event. Use this rather than delete_task when the work simply stopped.',
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
        "Hard-delete a task (DELETE /tasks/:id). For a mistake or a duplicate, not for work that stopped. Emits a deleted event. The row is gone, and an Idempotency-Key that pointed at it can be used again.",
      inputSchema: deleteTaskToolSchema,
    },
    async ({ id }) =>
      asTool(await callApi(app, authorization, `/tasks/${id}`, { method: httpOperations.deleteTask.method })),
  );

  server.registerTool(
    "add_task_link",
    {
      description:
        "Attach an http(s) link to a task (POST /tasks/:id/links). title is the label a person sees. The same taskId and url returns the existing link and does not add a second row. Use this for a page that holds options, a comparison, or research, instead of a long detail. url must be http or https.",
      inputSchema: addTaskLinkToolSchema,
    },
    async ({ taskId, ...body }) => {
      const parsed = createAttachedLinkSchema.parse(body);
      return asTool(await callApi(app, authorization, `/tasks/${taskId}/links`, {
        method: httpOperations.createTaskLink.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed),
      }));
    },
  );

  server.registerTool(
    "remove_task_link",
    {
      description:
        "Remove one link from a task (DELETE /tasks/:id/links/:linkId). linkId is the link id from the task's links. The task stays.",
      inputSchema: removeTaskLinkToolSchema,
    },
    async ({ taskId, linkId }) =>
      asTool(await callApi(app, authorization, `/tasks/${taskId}/links/${linkId}`, {
        method: httpOperations.deleteTaskLink.method,
      })),
  );

  server.registerTool(
    "snooze_task",
    {
      description:
        "Snooze an open task until an ISO time in the future (POST /tasks/:id/snooze). The action stays as it is, including do_now. The task leaves lists and the morning queue until then. until must be later than now.",
      inputSchema: snoozeTaskToolSchema,
    },
    async ({ id, until }) => {
      const parsed = snoozeTaskSchema.parse({ until });
      return asTool(await callApi(app, authorization, `/tasks/${id}/snooze`, {
        method: httpOperations.snoozeTask.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed),
      }));
    },
  );

  server.registerTool(
    "unsnooze_task",
    {
      description:
        "Clear a snooze (POST /tasks/:id/unsnooze). snoozedUntil becomes null and the task returns to its action lane. A task that is not snoozed is returned unchanged.",
      inputSchema: unsnoozeTaskToolSchema,
    },
    async ({ id }) =>
      asTool(await callApi(app, authorization, `/tasks/${id}/unsnooze`, {
        method: httpOperations.unsnoozeTask.method,
        headers: { "content-type": "application/json" },
        body: "{}",
      })),
  );

  server.registerTool(
    "list_tasks",
    {
      description:
        "List tasks (GET /tasks). Each task includes action, snoozedUntil, source (an email or url link, or null), links (http(s) pages attached to the task), plus project and area when set. Tasks with snoozedUntil still in the future are omitted unless includeSnoozed is true. Snoozing does not change action. Filter projectId together with action to separate a project's active steps (do_now, delegate, schedule) from later support steps. A bot's open delegate work is action=delegate, status=open, and owner=bot:<uuid>. Other filters: teamId, status (open, done, or cancelled), important, urgent, needsCalendar, owner (user:<uuid> or bot:<uuid>), dueBefore, areaId, mine. Open schedule tasks that still need a calendar are action=schedule, status=open, and needsCalendar=true. A check-in is an open schedule with dueAt in the past (dueBefore now), whether or not a calendar is attached. For another bot, add owner=bot:<uuid>. Omit teamId to use this bot's team. status=open hides cancelled tasks. status=cancelled is the audit list.",
      inputSchema: listTasksQuerySchema,
    },
    async (query) => asTool(await callApi(app, authorization, `${httpOperations.listTasks.path}${queryString(query)}`)),
  );

  server.registerTool(
    "list_do_immediately",
    {
      description:
        "Open work for the caller (GET /tasks/do-immediately). This token receives inBotQueue: open delegate tasks it owns, plus schedule tasks it owns that still need a calendar or are due for check-in (dueAt in the past, calendar attached or not). It does not include do_now or another bot's tasks. A human receives inMorningQueue: open do_now, schedule that still needs a calendar or is due for check-in, and overdue delegate follow-ups whose owner is not a bot. Done, cancelled, snoozed, and action later stay out, including future steps on a project. A snoozed task returns when snoozedUntil passes. Optional teamId.",
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
        "Update a project (PATCH /teams/:id/projects/:id). Change name, notes, areaId, or archived. Null notes clears the plan. Null areaId clears the area. archived true completes the project and is rejected while any task on it is still open. Complete or cancel those tasks first. Steps stay tasks. Omit teamId when this token belongs to one team.",
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
