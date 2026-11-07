/** A page someone can open again. `url` is absolute. */
export type PageLink = { title: string; url: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ShareOutcome = "copied" | "shared" | "cancelled" | "failed";

export function pageLink(path: string, title: string, origin: string): PageLink {
  const url = new URL(path, origin.endsWith("/") ? origin : `${origin}/`);
  return { title, url: url.toString() };
}

/** List id carried on a shared page so it reopens on that list. */
export function teamFromSearch(search: string): string | null {
  const team = new URLSearchParams(search).get("team");
  return team && UUID.test(team) ? team : null;
}

function pathWith(pathname: string, query: Record<string, string | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value) params.set(key, value);
  }
  const text = params.toString();
  return text ? `${pathname}?${text}` : pathname;
}

export function tasksPath(teamId: string | null, action: string | null): string {
  return pathWith("/tasks", {
    team: teamId,
    action: action && action !== "do_now" ? action : null,
  });
}

export function projectsPath(teamId: string | null): string {
  return pathWith("/projects", { team: teamId });
}

export function projectDetailPath(teamId: string | null, projectId: string): string {
  return pathWith(`/projects/${projectId}`, { team: teamId });
}

export function archivePath(teamId: string | null, status: string | null): string {
  return pathWith("/archive", {
    team: teamId,
    status: status && status !== "all" ? status : null,
  });
}

export function settingsPath(teamId: string | null): string {
  return teamId ? `/teams/${teamId}` : "/settings";
}

export function taskKeyPath(key: string): string {
  return `/t/${encodeURIComponent(key)}`;
}

export async function copyPageLink(url: string, writeText: (value: string) => Promise<void>): Promise<ShareOutcome> {
  try {
    await writeText(url);
    return "copied";
  } catch {
    return "failed";
  }
}

export function isShareCancellation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

export async function nativeShare(
  link: PageLink,
  share: (data: { title: string; url: string }) => Promise<void>,
): Promise<ShareOutcome> {
  try {
    await share({ title: link.title, url: link.url });
    return "shared";
  } catch (error) {
    if (isShareCancellation(error)) return "cancelled";
    return "failed";
  }
}
