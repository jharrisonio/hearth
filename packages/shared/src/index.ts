import { z } from "zod";

/** Locked v1 vocabulary. Eisenhower quadrant is derived, never stored. */
export const lanes = ["next", "waiting", "someday"] as const;
export const taskStatuses = ["open", "done"] as const;
export const teamKinds = ["personal", "household"] as const;
export const membershipRoles = ["owner", "member"] as const;
export const actorTypes = ["user", "bot"] as const;

export type Lane = (typeof lanes)[number];
export type TaskStatus = (typeof taskStatuses)[number];
export type TeamKind = (typeof teamKinds)[number];
export type MembershipRole = (typeof membershipRoles)[number];
export type ActorType = (typeof actorTypes)[number];

export const actorRefSchema = z.object({
  type: z.enum(actorTypes),
  id: z.string().uuid(),
});
export type ActorRef = z.infer<typeof actorRefSchema>;

export const taskSchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  title: z.string(),
  detail: z.string().nullable(),
  status: z.enum(taskStatuses),
  owner: actorRefSchema,
  important: z.boolean(),
  urgent: z.boolean(),
  lane: z.enum(lanes),
  waitingOn: z.string().nullable(),
  project: z.string().nullable(),
  dueAt: z.string().nullable(),
  outcome: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  createdBy: actorRefSchema,
});
export type Task = z.infer<typeof taskSchema>;

const dueAt = z.string().datetime({ offset: true }).nullable();

export const createTaskSchema = z
  .object({
    teamId: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    detail: z.string().trim().max(5000).nullable().optional(),
    owner: actorRefSchema.optional(),
    important: z.boolean().optional(),
    urgent: z.boolean().optional(),
    lane: z.enum(lanes).optional(),
    waitingOn: z.string().trim().max(200).nullable().optional(),
    project: z.string().trim().max(120).nullable().optional(),
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
    lane: z.enum(lanes).optional(),
    waitingOn: z.string().trim().max(200).nullable().optional(),
    project: z.string().trim().max(120).nullable().optional(),
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

/** HTTP shapes a future MCP wrapper can bind to without inventing fields. */
export const httpOperations = {
  createTask: { method: "POST", path: "/tasks" },
  updateTask: { method: "PATCH", path: "/tasks/:id" },
  completeTask: { method: "POST", path: "/tasks/:id/complete" },
  listTasks: { method: "GET", path: "/tasks" },
  listDoImmediately: { method: "GET", path: "/tasks/do-immediately" },
} as const;
