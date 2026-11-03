import { z } from "zod";

/** Stored next step. Important and urgent stay separate and still drive sort order. */
export const actions = ["do_now", "delegate", "schedule", "later"] as const;
export const taskStatuses = ["open", "done", "cancelled"] as const;
export const teamKinds = ["personal", "household"] as const;
export const membershipRoles = ["owner", "member"] as const;
export const actorTypes = ["user", "bot"] as const;
export const sourceTypes = ["email", "url"] as const;

export type Action = (typeof actions)[number];
export type TaskStatus = (typeof taskStatuses)[number];
export type TeamKind = (typeof teamKinds)[number];
export type MembershipRole = (typeof membershipRoles)[number];
export type ActorType = (typeof actorTypes)[number];
export type SourceType = (typeof sourceTypes)[number];

/** http(s) only, so a source link can be opened and cannot be a script URL. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Where a task came from. `email` is a mailbox deep link (Gmail's web URL goes in `href`).
 * `url` is any other page. `externalId` is the provider's id, not the link itself.
 */
export const taskSourceSchema = z
  .object({
    type: z.enum(sourceTypes),
    href: z.string().trim().min(1).max(2048).refine(isHttpUrl, "must be an http(s) URL"),
    label: z.string().trim().min(1).max(200).optional(),
    externalId: z.string().trim().min(1).max(512).optional(),
  })
  .strict();
export type TaskSource = z.infer<typeof taskSourceSchema>;

/** Three days as an exact duration. The SQL migration uses `interval '3 days'`. */
export const FOLLOW_UP_MS = 3 * 24 * 60 * 60 * 1000;

export function followUpFrom(from: Date): Date {
  return new Date(from.getTime() + FOLLOW_UP_MS);
}

/** IU → do_now, urgent only → delegate, important only → schedule, neither → later. */
export function suggestAction(important: boolean, urgent: boolean): Action {
  if (important && urgent) return "do_now";
  if (urgent) return "delegate";
  if (important) return "schedule";
  return "later";
}

/**
 * A schedule task with no calendar id needs a calendar.
 * Any calendar id or http(s) calendar URL forces needsCalendar false.
 * Leaving schedule clears an implied needsCalendar unless the caller sets one.
 */
export function resolveNeedsCalendar(
  action: Action,
  calendarEventId: string | null,
  explicit: boolean | undefined,
  previous: { action: Action; needsCalendar: boolean } | null,
): boolean {
  if (calendarEventId) return false;
  if (action === "schedule") return true;
  if (explicit !== undefined) return explicit;
  if (!previous || previous.action === "schedule") return false;
  return previous.needsCalendar;
}

/**
 * Open an attached calendar event.
 * An http(s) value is the link that was pasted. Anything else is a Google Calendar event id.
 */
export function calendarHref(calendarEventId: string | null | undefined): string | null {
  const value = calendarEventId?.trim() ?? "";
  if (!value) return null;
  if (isHttpUrl(value)) return value;
  return `https://calendar.google.com/calendar/u/0/r/eventedit/${encodeURIComponent(value)}`;
}

/**
 * Check-in set. An open schedule task whose event time (`dueAt`) is strictly in the past.
 * The calendar may already be attached. `dueAt` is that time; there is no separate end.
 */
export function needsCheckIn(
  task: {
    status: TaskStatus;
    action: Action;
    dueAt: string | Date | null;
  },
  now: Date = new Date(),
): boolean {
  if (task.status !== "open" || task.action !== "schedule") return false;
  if (task.dueAt == null) return false;
  const dueMs = new Date(task.dueAt).getTime();
  return !Number.isNaN(dueMs) && dueMs < now.getTime();
}

/**
 * A linked schedule uses `dueAt` as the event time so check-in can fire after it.
 * Other actions may store a calendar id without a time.
 */
export function scheduleRequiresDueAt(
  action: Action,
  calendarEventId: string | null | undefined,
  dueAt: string | Date | null | undefined,
): boolean {
  const linked = typeof calendarEventId === "string" && calendarEventId.trim().length > 0;
  return action === "schedule" && linked && (dueAt == null || dueAt === "");
}

/**
 * waitingOn names an outsider (Tara, the CRA). A bot owner is already who acts,
 * so waitingOn may be null. No owner counts as not a bot.
 */
export function delegateRequiresWaitingOn(
  action: Action,
  owner: { type: ActorType } | null | undefined,
): boolean {
  return action === "delegate" && owner?.type !== "bot";
}

/**
 * Active next action on a project.
 * `later` is a future or dependent support step, not a front.
 * Several fronts may be open at once.
 */
export function isProjectFront(action: Action): boolean {
  return action === "do_now" || action === "delegate" || action === "schedule";
}

/**
 * Human morning queue. Open tasks only: done, cancelled, and `later` stay out.
 * Schedule is in when it needs a calendar, or when `needsCheckIn` (`dueAt` strictly past).
 * An outsider delegate includes due now.
 * Pass `owner` so a bot-owned delegate stays out. Without `owner`, a delegate is treated as an outsider.
 * Bot-owned schedule stays here too, and `inBotQueue` uses the same schedule rule for the owning bot.
 */
export function inMorningQueue(
  task: {
    status: TaskStatus;
    action: Action;
    needsCalendar: boolean;
    dueAt: string | Date | null;
    createdAt: string | Date;
    owner?: { type: ActorType };
  },
  now: Date = new Date(),
): boolean {
  if (task.status !== "open") return false;
  if (task.action === "do_now") return true;
  const dueMs = task.dueAt == null ? null : new Date(task.dueAt).getTime();
  if (task.action === "schedule") return task.needsCalendar || needsCheckIn(task, now);
  if (task.action === "delegate") {
    if (task.owner?.type === "bot") return false;
    if (dueMs != null && !Number.isNaN(dueMs) && dueMs <= now.getTime()) return true;
    if (dueMs == null) {
      const createdMs = new Date(task.createdAt).getTime();
      return !Number.isNaN(createdMs) && createdMs < now.getTime() - FOLLOW_UP_MS;
    }
  }
  // `later`, including a project's future steps, stays out until the action changes.
  return false;
}

/**
 * Open work GET /tasks/do-immediately returns when the caller is a bot token.
 * `actorId` is that token's id. An open delegate counts at any follow-up.
 * Schedule counts when it still needs a calendar or `needsCheckIn` (`dueAt` strictly past),
 * so the owning bot sees its schedule check-ins. The same rule is in `inMorningQueue`.
 * do_now stays on the human morning queue: do now is the human doing it.
 */
export function inBotQueue(
  task: {
    status: TaskStatus;
    action: Action;
    needsCalendar: boolean;
    dueAt: string | Date | null;
    owner: { type: ActorType; id: string };
  },
  actorId: string,
  now: Date = new Date(),
): boolean {
  if (task.status !== "open") return false;
  if (task.owner.type !== "bot" || task.owner.id !== actorId) return false;
  if (task.action === "delegate") return true;
  if (task.action === "schedule") return task.needsCalendar || needsCheckIn(task, now);
  return false;
}

export const actorRefSchema = z.object({
  type: z.enum(actorTypes),
  id: z.string().uuid(),
});
export type ActorRef = z.infer<typeof actorRefSchema>;

/** Project or area as it appears on a task. The catalog endpoints return the fuller summary. */
export const taskLinkSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});
export type TaskLink = z.infer<typeof taskLinkSchema>;

/** An http(s) page attached to a task. Separate from `source`, which is where the task came from. */
export const attachedLinkSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  url: z.string(),
  position: z.number().int(),
  createdBy: actorRefSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AttachedLink = z.infer<typeof attachedLinkSchema>;

const linkTitle = z.string().trim().min(1).max(200);
const linkUrl = z.string().trim().min(1).max(2048).refine(isHttpUrl, "must be an http(s) URL");

export const createAttachedLinkSchema = z
  .object({
    title: linkTitle,
    url: linkUrl,
    position: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();
export type CreateAttachedLinkInput = z.infer<typeof createAttachedLinkSchema>;

export const updateAttachedLinkSchema = z
  .object({
    title: linkTitle.optional(),
    url: linkUrl.optional(),
    position: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict()
  .refine((value) => value.title !== undefined || value.url !== undefined || value.position !== undefined, {
    message: "Provide a title, url, or position.",
  });
export type UpdateAttachedLinkInput = z.infer<typeof updateAttachedLinkSchema>;

export interface DeletedLink {
  id: string;
  deleted: true;
}

export const taskSchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  title: z.string(),
  detail: z.string().nullable(),
  status: z.enum(taskStatuses),
  owner: actorRefSchema,
  important: z.boolean(),
  urgent: z.boolean(),
  action: z.enum(actions),
  waitingOn: z.string().nullable(),
  calendarEventId: z.string().nullable(),
  needsCalendar: z.boolean(),
  project: taskLinkSchema.nullable(),
  area: taskLinkSchema.nullable(),
  source: taskSourceSchema.nullable(),
  links: z.array(attachedLinkSchema),
  dueAt: z.string().nullable(),
  outcome: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  /** Position among steps on the same project. Null sorts after numbered steps. */
  sortOrder: z.number().int().nullable(),
  createdBy: actorRefSchema,
});
export type Task = z.infer<typeof taskSchema>;

/** Names emitted on GET /teams/:id/events. */
export const taskEventTypes = ["created", "updated", "completed", "cancelled", "deleted"] as const;
export type TaskEventType = (typeof taskEventTypes)[number];

/**
 * One task write. For create, update, complete, and cancel, `at` is that
 * write's `updatedAt`. For delete, `at` is when the row was removed.
 * `task` is the same object as the task API. On the process that handled the
 * write, it is the row just saved, or the row just removed. On another API
 * process it is the row read when the notice arrived. A deleted row is already
 * gone, so `task` is null there. `taskId` is enough to drop it.
 */
export interface TaskEvent {
  type: TaskEventType;
  teamId: string;
  taskId: string;
  at: string;
  task: Task | null;
}

const dueAt = z.string().datetime({ offset: true }).nullable();

/** Event id or the calendar URL a person pasted. Any non-empty value clears needsCalendar. */
const calendarEventIdInput = z
  .string()
  .trim()
  .max(1024)
  .nullable()
  .optional()
  .describe(
    "Event id or an http(s) calendar URL, such as a Google Calendar event link. Any value clears needsCalendar. On action schedule, dueAt is required with it and is the event time used for check-in.",
  );
const sortOrder = z.number().int().min(0).max(1_000_000).nullable();

/** Outsider a human owner is waiting on. A bot owner may omit it. */
const waitingOnInput = z
  .string()
  .trim()
  .max(200)
  .nullable()
  .optional()
  .describe(
    "Required when action is delegate and the owner is not a bot. Optional, and may be null, when owner.type is bot.",
  );

export const createTaskSchema = z
  .object({
    teamId: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    detail: z.string().trim().max(5000).nullable().optional(),
    owner: actorRefSchema.optional(),
    important: z.boolean().optional(),
    urgent: z.boolean().optional(),
    action: z.enum(actions).optional(),
    waitingOn: waitingOnInput,
    calendarEventId: calendarEventIdInput,
    needsCalendar: z.boolean().optional(),
    projectId: z.string().uuid().nullable().optional(),
    areaId: z.string().uuid().nullable().optional(),
    source: taskSourceSchema.nullable().optional(),
    dueAt: dueAt.optional(),
    sortOrder: sortOrder.optional(),
  })
  .strict();
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    detail: z.string().trim().max(5000).nullable().optional(),
    owner: actorRefSchema.optional(),
    important: z.boolean().optional(),
    urgent: z.boolean().optional(),
    action: z.enum(actions).optional(),
    waitingOn: waitingOnInput,
    calendarEventId: calendarEventIdInput,
    needsCalendar: z.boolean().optional(),
    projectId: z.string().uuid().nullable().optional(),
    areaId: z.string().uuid().nullable().optional(),
    source: taskSourceSchema.nullable().optional(),
    dueAt: dueAt.optional(),
    sortOrder: sortOrder.optional(),
  })
  .strict();
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const completeTaskSchema = z
  .object({
    outcome: z.string().trim().min(1).max(2000),
  })
  .strict();
export type CompleteTaskInput = z.infer<typeof completeTaskSchema>;

/** Omit `outcome` and the server stores "cancelled". */
export const cancelTaskSchema = z
  .object({
    outcome: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();
export type CancelTaskInput = z.infer<typeof cancelTaskSchema>;

export interface DeletedTask {
  id: string;
  deleted: true;
}

export const createTeamSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
  })
  .strict();

export const addMemberSchema = z
  .object({
    email: z.string().trim().email().max(200),
  })
  .strict();

export const createTokenSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
  })
  .strict();

/** Register a bot identity. No secret. `agentId` is the external id, unique per team. */
export const registerBotSchema = z
  .object({
    agentId: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(80),
  })
  .strict();
export type RegisterBotInput = z.infer<typeof registerBotSchema>;

/** Rename a registered bot. The id stays so existing tasks keep their owner. */
export const renameBotSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
  })
  .strict();
export type RenameBotInput = z.infer<typeof renameBotSchema>;

/** One agent a connector may offer at consent time. The same shape as registering a bot. */
export const oauthAgentSchema = registerBotSchema;
export type OAuthAgent = z.infer<typeof oauthAgentSchema>;

export const oauthConsentSchema = z
  .object({
    request: z.string().uuid(),
    teamIds: z.array(z.string().uuid()).min(1).max(20),
    bots: z.array(oauthAgentSchema).max(20).optional(),
  })
  .strict();
export type OAuthConsentInput = z.infer<typeof oauthConsentSchema>;

export const oauthDenySchema = z
  .object({
    request: z.string().uuid(),
  })
  .strict();

/**
 * A relative path we are willing to send the browser back to after sign-in.
 * Rejects protocol-relative and absolute URLs.
 */
export function safeNextPath(value: string | null | undefined): string | null {
  if (!value || value.length > 2000) return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return null;
  if (value.includes("\\") || value.includes("://") || /[\r\n\0]/.test(value)) return null;
  return value;
}

export const devLoginSchema = z
  .object({
    email: z.string().trim().email().max(200),
  })
  .strict();

export interface TeamSummary {
  id: string;
  name: string;
  kind: TeamKind;
  role: MembershipRole;
  createdAt: string;
}

export interface Member {
  userId: string;
  email: string;
  name: string;
  role: MembershipRole;
}

export interface BotSummary {
  id: string;
  teamId: string;
  agentId: string;
  name: string;
  createdAt: string;
}

export interface BotTokenSummary {
  id: string;
  teamId: string;
  label: string;
  prefix: string;
  createdAt: string;
  revokedAt: string | null;
  createdByUserId: string;
}

export interface AuthConfig {
  devAuth: boolean;
  google: boolean;
  devUsers?: { email: string; name: string }[];
  /** Canonical MCP URL. Connectors discover OAuth from this origin. */
  mcpUrl: string;
}

/** What the consent page shows before the person approves. */
export interface OAuthRequestPreview {
  requestId: string;
  clientName: string;
  redirectUri: string;
  redirectHost: string;
  loopback: boolean;
  scope: string;
  agents: OAuthAgent[];
  expiresAt: string;
}

/** An MCP client authorised for the current list. */
export interface ConnectorSummary {
  id: string;
  clientId: string;
  clientName: string;
  createdAt: string;
}

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
}

export interface TaskList {
  tasks: Task[];
}

/** HTTP shapes the MCP tools bind to. They do not add task fields. */
export const httpOperations = {
  createTask: { method: "POST", path: "/tasks" },
  updateTask: { method: "PATCH", path: "/tasks/:id" },
  completeTask: { method: "POST", path: "/tasks/:id/complete" },
  cancelTask: { method: "POST", path: "/tasks/:id/cancel" },
  deleteTask: { method: "DELETE", path: "/tasks/:id" },
  listTasks: { method: "GET", path: "/tasks" },
  listDoImmediately: { method: "GET", path: "/tasks/do-immediately" },
  listTaskLinks: { method: "GET", path: "/tasks/:id/links" },
  createTaskLink: { method: "POST", path: "/tasks/:id/links" },
  updateTaskLink: { method: "PATCH", path: "/tasks/:id/links/:linkId" },
  deleteTaskLink: { method: "DELETE", path: "/tasks/:id/links/:linkId" },
  taskEvents: { method: "GET", path: "/teams/:id/events" },
} as const;

/** Replay window for an Idempotency-Key on POST /tasks, per actor. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Header on POST /tasks. The MCP create_task tool sends this from `idempotencyKey`. */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

/** Printable ASCII, no spaces. UUIDs and similar tokens fit. */
export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7E]+$/);
export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;

const ownerQuery = z
  .string()
  .regex(/^(user|bot):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

/** Filters on GET /tasks. Booleans are JSON values; the HTTP query string uses true/false. */
export const listTasksQuerySchema = z
  .object({
    teamId: z.string().uuid().optional(),
    action: z.enum(actions).optional(),
    status: z.enum(taskStatuses).optional(),
    important: z.boolean().optional(),
    urgent: z.boolean().optional(),
    needsCalendar: z
      .boolean()
      .optional()
      .describe("Filter tasks that still need a calendar. Pair with action=schedule and status=open."),
    owner: ownerQuery.optional(),
    dueBefore: z.string().min(1).max(40).optional(),
    projectId: z.string().uuid().optional(),
    areaId: z.string().uuid().optional(),
    mine: z.boolean().optional(),
  })
  .strict();
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

export const doImmediatelyQuerySchema = z
  .object({
    teamId: z.string().uuid().optional(),
  })
  .strict();
export type DoImmediatelyQuery = z.infer<typeof doImmediatelyQuerySchema>;

/** create_task arguments. `idempotencyKey` is not a task field; it becomes the HTTP header. */
export const createTaskToolSchema = createTaskSchema.extend({
  idempotencyKey: idempotencyKeySchema.optional(),
});
export type CreateTaskToolInput = z.infer<typeof createTaskToolSchema>;

export const updateTaskToolSchema = updateTaskSchema.extend({
  id: z.string().uuid(),
});
export type UpdateTaskToolInput = z.infer<typeof updateTaskToolSchema>;

export const completeTaskToolSchema = completeTaskSchema.extend({
  id: z.string().uuid(),
});
export type CompleteTaskToolInput = z.infer<typeof completeTaskToolSchema>;

export const cancelTaskToolSchema = cancelTaskSchema.extend({
  id: z.string().uuid(),
});
export type CancelTaskToolInput = z.infer<typeof cancelTaskToolSchema>;

export const deleteTaskToolSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();
export type DeleteTaskToolInput = z.infer<typeof deleteTaskToolSchema>;

/** add_task_link. The same task and url returns the existing row. */
export const addTaskLinkToolSchema = z
  .object({
    taskId: z.string().uuid(),
    title: linkTitle,
    url: linkUrl,
  })
  .strict();
export type AddTaskLinkToolInput = z.infer<typeof addTaskLinkToolSchema>;

export const removeTaskLinkToolSchema = z
  .object({
    taskId: z.string().uuid(),
    linkId: z.string().uuid(),
  })
  .strict();
export type RemoveTaskLinkToolInput = z.infer<typeof removeTaskLinkToolSchema>;

/**
 * Kept for the REST body shape. These tools are not registered on the MCP server.
 * Bot owners are named at consent and in Settings.
 */
export const registerBotToolSchema = registerBotSchema.extend({
  teamId: z.string().uuid().optional(),
});
export type RegisterBotToolInput = z.infer<typeof registerBotToolSchema>;

export const listBotsToolSchema = z
  .object({
    teamId: z.string().uuid().optional(),
  })
  .strict();
export type ListBotsToolInput = z.infer<typeof listBotsToolSchema>;

export const unregisterBotToolSchema = z
  .object({
    id: z.string().uuid(),
    teamId: z.string().uuid().optional(),
  })
  .strict();
export type UnregisterBotToolInput = z.infer<typeof unregisterBotToolSchema>;

/** An area (life or work domain) on one team. */
export const namedSummarySchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  name: z.string(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AreaSummary = z.infer<typeof namedSummarySchema>;

/** A project (multi-step outcome). `notes` is the support plan, not the step list. `area` is the domain it sits in. */
export const projectSummarySchema = namedSummarySchema.extend({
  notes: z.string().nullable(),
  area: taskLinkSchema.nullable(),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

const projectNotes = z.string().trim().max(5000).nullable();

export const createProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    notes: projectNotes.optional(),
  })
  .strict();
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    notes: projectNotes.optional(),
    areaId: z.string().uuid().nullable().optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined || value.notes !== undefined || value.areaId !== undefined || value.archived !== undefined,
    { message: "Provide a name, notes, area, or archived." },
  );
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const createAreaSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
  })
  .strict();
export type CreateAreaInput = z.infer<typeof createAreaSchema>;

export const updateAreaSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.archived !== undefined, {
    message: "Provide a name or archived.",
  });
export type UpdateAreaInput = z.infer<typeof updateAreaSchema>;

export const createProjectToolSchema = createProjectSchema.extend({
  teamId: z.string().uuid().optional(),
});
export type CreateProjectToolInput = z.infer<typeof createProjectToolSchema>;

export const updateProjectToolSchema = z
  .object({
    id: z.string().uuid(),
    teamId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(120).optional(),
    notes: projectNotes.optional(),
    areaId: z.string().uuid().nullable().optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.notes !== undefined ||
      value.areaId !== undefined ||
      value.archived !== undefined,
    { message: "Provide a name, notes, area, or archived." },
  );
export type UpdateProjectToolInput = z.infer<typeof updateProjectToolSchema>;

export const createAreaToolSchema = createAreaSchema.extend({
  teamId: z.string().uuid().optional(),
});
export type CreateAreaToolInput = z.infer<typeof createAreaToolSchema>;

export const listNamedToolSchema = z
  .object({
    teamId: z.string().uuid().optional(),
    includeArchived: z.boolean().optional(),
  })
  .strict();
export type ListNamedToolInput = z.infer<typeof listNamedToolSchema>;
