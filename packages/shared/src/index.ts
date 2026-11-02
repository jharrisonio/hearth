import { z } from "zod";

/** Stored next step. Important and urgent stay separate and still drive sort order. */
export const actions = ["do_now", "delegate", "schedule", "later"] as const;
export const taskStatuses = ["open", "done"] as const;
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
 * Any calendar id forces needsCalendar false.
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

/** Morning queue. Schedule is strictly overdue; a delegate follow-up includes due now. */
export function inMorningQueue(
  task: {
    status: TaskStatus;
    action: Action;
    needsCalendar: boolean;
    dueAt: string | Date | null;
    createdAt: string | Date;
  },
  now: Date = new Date(),
): boolean {
  if (task.status !== "open") return false;
  if (task.action === "do_now") return true;
  const dueMs = task.dueAt == null ? null : new Date(task.dueAt).getTime();
  if (task.action === "schedule") {
    if (task.needsCalendar) return true;
    return dueMs != null && !Number.isNaN(dueMs) && dueMs < now.getTime();
  }
  if (task.action === "delegate") {
    if (dueMs != null && !Number.isNaN(dueMs) && dueMs <= now.getTime()) return true;
    if (dueMs == null) {
      const createdMs = new Date(task.createdAt).getTime();
      return !Number.isNaN(createdMs) && createdMs < now.getTime() - FOLLOW_UP_MS;
    }
  }
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
  dueAt: z.string().nullable(),
  outcome: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  createdBy: actorRefSchema,
});
export type Task = z.infer<typeof taskSchema>;

/** Names emitted on GET /teams/:id/events. Tasks are not deleted, so there is no deleted event. */
export const taskEventTypes = ["created", "updated", "completed"] as const;
export type TaskEventType = (typeof taskEventTypes)[number];

/**
 * One task write. `at` is that write's `updatedAt`.
 * `task` is the same object as the task API. On the process that handled the
 * write, it is the row just saved. On another API process it is the row read
 * when the notice arrived.
 */
export interface TaskEvent {
  type: TaskEventType;
  teamId: string;
  taskId: string;
  at: string;
  task: Task;
}

const dueAt = z.string().datetime({ offset: true }).nullable();

export const createTaskSchema = z
  .object({
    teamId: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    detail: z.string().trim().max(5000).nullable().optional(),
    owner: actorRefSchema.optional(),
    important: z.boolean().optional(),
    urgent: z.boolean().optional(),
    action: z.enum(actions).optional(),
    waitingOn: z.string().trim().max(200).nullable().optional(),
    calendarEventId: z.string().trim().max(1024).nullable().optional(),
    needsCalendar: z.boolean().optional(),
    projectId: z.string().uuid().nullable().optional(),
    areaId: z.string().uuid().nullable().optional(),
    source: taskSourceSchema.nullable().optional(),
    dueAt: dueAt.optional(),
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
    waitingOn: z.string().trim().max(200).nullable().optional(),
    calendarEventId: z.string().trim().max(1024).nullable().optional(),
    needsCalendar: z.boolean().optional(),
    projectId: z.string().uuid().nullable().optional(),
    areaId: z.string().uuid().nullable().optional(),
    source: taskSourceSchema.nullable().optional(),
    dueAt: dueAt.optional(),
  })
  .strict();
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const completeTaskSchema = z
  .object({
    outcome: z.string().trim().min(1).max(2000),
  })
  .strict();
export type CompleteTaskInput = z.infer<typeof completeTaskSchema>;

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
  listTasks: { method: "GET", path: "/tasks" },
  listDoImmediately: { method: "GET", path: "/tasks/do-immediately" },
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

/** teamId is optional for a bot token, which belongs to one team. */
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

/** A project (multi-step outcome) or an area (life or work domain) on one team. */
export const namedSummarySchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  name: z.string(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectSummary = z.infer<typeof namedSummarySchema>;
export type AreaSummary = ProjectSummary;

export const createProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
  })
  .strict();
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.archived !== undefined, {
    message: "Provide a name or archived.",
  });
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
