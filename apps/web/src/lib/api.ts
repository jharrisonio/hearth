import type {
  Action,
  AreaSummary,
  AuthConfig,
  BotSummary,
  BotTokenSummary,
  CurrentUser,
  DeletedTask,
  Member,
  ProjectSummary,
  Task,
  TaskList,
  TaskStatus,
  TeamSummary,
} from "@hearth/shared";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`/api${path}`, { ...init, headers, credentials: "same-origin" });
  const text = await response.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const body = data as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(response.status, body?.error?.code ?? "error", body?.error?.message ?? response.statusText);
  }
  return data as T;
}

export type TaskQuery = {
  teamId?: string;
  action?: Action;
  status?: TaskStatus;
  important?: boolean;
  urgent?: boolean;
  owner?: string;
  dueBefore?: string;
  projectId?: string;
  areaId?: string;
  mine?: boolean;
};

function queryString(query: TaskQuery) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export const api = {
  config: () => request<AuthConfig>("/auth/config"),
  devLogin: (email: string) =>
    request<{ user: CurrentUser }>("/auth/dev", { method: "POST", body: JSON.stringify({ email }) }),
  me: () => request<{ user: CurrentUser }>("/auth/me"),
  logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  teams: () => request<{ teams: TeamSummary[] }>("/teams"),
  createTeam: (name: string) =>
    request<TeamSummary>("/teams", { method: "POST", body: JSON.stringify({ name }) }),
  team: (teamId: string) => request<{ team: TeamSummary; members: Member[] }>(`/teams/${teamId}`),
  addMember: (teamId: string, email: string) =>
    request<Member>(`/teams/${teamId}/members`, { method: "POST", body: JSON.stringify({ email }) }),
  tokens: (teamId: string) => request<{ tokens: BotTokenSummary[] }>(`/teams/${teamId}/tokens`),
  createToken: (teamId: string, label: string) =>
    request<{ token: BotTokenSummary; secret: string }>(`/teams/${teamId}/tokens`, {
      method: "POST",
      body: JSON.stringify({ label }),
    }),
  revokeToken: (teamId: string, tokenId: string) =>
    request<{ token: BotTokenSummary }>(`/teams/${teamId}/tokens/${tokenId}`, { method: "DELETE" }),
  bots: (teamId: string) => request<{ bots: BotSummary[] }>(`/teams/${teamId}/bots`),
  registerBot: (teamId: string, body: { agentId: string; name: string }) =>
    request<BotSummary>(`/teams/${teamId}/bots`, { method: "POST", body: JSON.stringify(body) }),
  unregisterBot: (teamId: string, botId: string) =>
    request<BotSummary>(`/teams/${teamId}/bots/${botId}`, { method: "DELETE" }),
  projects: (teamId: string, includeArchived = false) =>
    request<{ projects: ProjectSummary[] }>(
      `/teams/${teamId}/projects${includeArchived ? "?includeArchived=true" : ""}`,
    ),
  createProject: (teamId: string, body: { name: string; notes?: string | null }) =>
    request<ProjectSummary>(`/teams/${teamId}/projects`, { method: "POST", body: JSON.stringify(body) }),
  updateProject: (teamId: string, id: string, body: { name?: string; notes?: string | null; archived?: boolean }) =>
    request<ProjectSummary>(`/teams/${teamId}/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  areas: (teamId: string, includeArchived = false) =>
    request<{ areas: AreaSummary[] }>(`/teams/${teamId}/areas${includeArchived ? "?includeArchived=true" : ""}`),
  createArea: (teamId: string, name: string) =>
    request<AreaSummary>(`/teams/${teamId}/areas`, { method: "POST", body: JSON.stringify({ name }) }),
  updateArea: (teamId: string, id: string, body: { name?: string; archived?: boolean }) =>
    request<AreaSummary>(`/teams/${teamId}/areas/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  tasks: (query: TaskQuery) => request<TaskList>(`/tasks${queryString(query)}`),
  doImmediately: (teamId?: string) =>
    request<TaskList>(`/tasks/do-immediately${teamId ? `?teamId=${teamId}` : ""}`),
  createTask: (body: unknown) => request<Task>("/tasks", { method: "POST", body: JSON.stringify(body) }),
  updateTask: (id: string, body: unknown) =>
    request<Task>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  completeTask: (id: string, outcome: string) =>
    request<Task>(`/tasks/${id}/complete`, { method: "POST", body: JSON.stringify({ outcome }) }),
  cancelTask: (id: string, outcome?: string) =>
    request<Task>(`/tasks/${id}/cancel`, {
      method: "POST",
      body: JSON.stringify(outcome === undefined ? {} : { outcome }),
    }),
  deleteTask: (id: string) => request<DeletedTask>(`/tasks/${id}`, { method: "DELETE" }),
};
