import type { AreaSummary, AuthConfig, BotSummary, BotTokenSummary, Member, ProjectSummary, TeamSummary } from "@hearth/shared";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useAuth } from "@/auth";
import { CloseIcon, iconButtonClass } from "@/components/Icons";
import { Button } from "@/components/ui/button";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { fieldClass, labelClass, pageTitleClass, sectionClass, subheadClass } from "@/lib/field";
import { LIST_KEY } from "@/lib/list";

export function Settings() {
  const { teamId } = useParams();
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [team, setTeam] = useState<TeamSummary | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [tokens, setTokens] = useState<BotTokenSummary[]>([]);
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [areas, setAreas] = useState<AreaSummary[]>([]);
  const [email, setEmail] = useState("");
  const [agentId, setAgentId] = useState("");
  const [botName, setBotName] = useState("");
  const [label, setLabel] = useState("");
  const [listName, setListName] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [confirmUnregister, setConfirmUnregister] = useState<string | null>(null);
  const [config, setConfig] = useState<AuthConfig | null>(null);

  async function load(id: string) {
    setError(null);
    try {
      const [detail, tokenList, botList, projectList, areaList] = await Promise.all([
        api.team(id),
        api.tokens(id),
        api.bots(id),
        api.projects(id, true),
        api.areas(id, true),
      ]);
      setTeam(detail.team);
      setMembers(detail.members);
      setTokens(tokenList.tokens);
      setBots(botList.bots);
      setProjects(projectList.projects);
      setAreas(areaList.areas);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this team.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void api
      .teams()
      .then(({ teams: next }) => {
        if (cancelled) return;
        setTeams(next);
        if (!teamId) {
          const id = next.find((item) => item.kind === "household")?.id ?? next[0]?.id;
          if (id) navigate(`/teams/${id}`, { replace: true });
          else setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Could not load your lists.");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, navigate]);

  useEffect(() => {
    if (teamId) void load(teamId);
  }, [teamId]);

  useEffect(() => {
    void api.config().then(setConfig).catch(() => setConfig(null));
  }, []);

  const isOwner = team?.role === "owner";

  function openList(id: string) {
    sessionStorage.setItem(LIST_KEY, id);
    navigate(`/teams/${id}`);
  }

  async function addMember(event: React.FormEvent) {
    event.preventDefault();
    setNotice(null);
    setError(null);
    try {
      await api.addMember(teamId!, email.trim());
      setEmail("");
      setNotice("Added to the household.");
      await load(teamId!);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add that person.");
    }
  }

  async function registerBot(event: React.FormEvent) {
    event.preventDefault();
    setNotice(null);
    setError(null);
    try {
      const registered = await api.registerBot(teamId!, { agentId: agentId.trim(), name: botName.trim() });
      setAgentId("");
      setBotName("");
      setNotice(`${registered.name} is registered.`);
      await load(teamId!);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not register that bot.");
    }
  }

  async function unregister(botId: string) {
    setError(null);
    try {
      await api.unregisterBot(teamId!, botId);
      setConfirmUnregister(null);
      setNotice("Bot unregistered. Tasks already assigned to them keep that owner.");
      await load(teamId!);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not unregister that bot.");
    }
  }

  async function createToken(event: React.FormEvent) {
    event.preventDefault();
    setNotice(null);
    setError(null);
    try {
      const created = await api.createToken(teamId!, label.trim());
      setSecret(created.secret);
      setLabel("");
      await load(teamId!);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create a token.");
    }
  }

  async function createList(event: React.FormEvent) {
    event.preventDefault();
    const name = listName.trim();
    if (!name) return;
    setNotice(null);
    setError(null);
    try {
      const created = await api.createTeam(name);
      setListName("");
      sessionStorage.setItem(LIST_KEY, created.id);
      navigate(`/teams/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the household.");
    }
  }

  async function revoke(tokenId: string) {
    setError(null);
    try {
      await api.revokeToken(teamId!, tokenId);
      setConfirmRevoke(null);
      if (secret) setSecret(null);
      await load(teamId!);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not revoke that token.");
    }
  }

  return (
    <div className="min-h-dvh bg-black text-white">
      <Link to="/" aria-label="Close" className={cn(iconButtonClass, "fixed right-2.5 top-2.5 z-10")}>
        <CloseIcon />
      </Link>
      <main className="hearth-sheet mx-auto min-h-dvh w-full max-w-[560px] px-7 pb-20 pt-[92px]">
        <h1 className={pageTitleClass}>Settings</h1>
        {loading ? <p className="text-[10px] uppercase tracking-[0.4em] text-[#4a4a4a]">Loading</p> : null}
        {error ? <p className="mb-6 text-[13px] text-[#c9a35a]">{error}</p> : null}
        {notice ? <p className="mb-6 text-[13px] text-[#cfcfcf]">{notice}</p> : null}

        <section>
          <h2 className={sectionClass}>Global</h2>
          <h3 className={subheadClass}>Google account</h3>
          <div className="flex items-baseline justify-between gap-4 border-b border-[#1c1c1c] py-3.5 text-[14px] font-light">
            <span className="min-w-0 truncate">{user?.email}</span>
            <span className="shrink-0 text-[13px] text-[#cfcfcf]">Signed in</span>
          </div>
          {config?.google ? (
            <div className="flex items-baseline justify-between gap-4 border-b border-[#1c1c1c] py-3.5 text-[14px]">
              <span className="text-[#8a8a8a]">Google</span>
              <button
                type="button"
                className="text-[10px] font-normal uppercase tracking-[0.32em] text-[#8a8a8a] hover:text-white"
                onClick={() => {
                  window.location.href = "/api/auth/google";
                }}
              >
                Connect
              </button>
            </div>
          ) : (
            <div className="flex items-baseline justify-between gap-4 border-b border-[#1c1c1c] py-3.5 text-[14px]">
              <span className="text-[#8a8a8a]">Google sign-in</span>
              <span className="text-[13px] text-[#666]">Off</span>
            </div>
          )}
          <button
            type="button"
            className="mt-6 text-[10px] font-normal uppercase tracking-[0.32em] text-[#8a8a8a] hover:text-white"
            onClick={() => void signOut()}
          >
            Sign out
          </button>

          <h3 className={subheadClass}>Your lists</h3>
          <ul>
            {teams.map((item) => {
              const current = item.id === team?.id;
              return (
                <li key={item.id} className="border-b border-[#1c1c1c]">
                  <button
                    type="button"
                    onClick={() => openList(item.id)}
                    className="flex w-full items-baseline justify-between gap-4 py-3.5 text-left text-[14px] font-light"
                  >
                    <span className={current ? "text-white" : "text-[#ccc]"}>
                      {current ? <span className="mr-2 text-[8px] text-[#9c9]">●</span> : null}
                      {item.name}
                    </span>
                    <span className="shrink-0 text-[12px] text-[#666]">{item.kind}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <form onSubmit={(event) => void createList(event)} className="mt-2 flex items-end gap-4">
            <label className="block min-w-0 flex-1">
              <span className="sr-only">New list name</span>
              <input
                className={fieldClass}
                value={listName}
                placeholder="New list name"
                onChange={(event) => setListName(event.target.value)}
              />
            </label>
            <Button type="submit">Create</Button>
          </form>
        </section>

        {team ? (
          <section className="mt-[72px]">
            <h2 className={sectionClass}>This list — {team.name}</h2>
            <p className="mt-4 text-[12px] font-light text-[#666]">
              {team.kind === "personal" ? "Personal" : "Household"} / {team.role === "owner" ? "Owner" : "Member"}
            </p>

            <h3 className={subheadClass}>Members</h3>
            <p className="mb-2 text-[13px] font-light text-[#5c5c5c]">
              {team.kind === "personal"
                ? "A personal list stays with you. Bots you grant can still post here."
                : "Members can see and update household tasks. Only an owner can invite or mint tokens."}
            </p>
            <ul>
              {members.map((member) => (
                <li
                  key={member.userId}
                  className="flex items-baseline justify-between gap-4 border-b border-[#1c1c1c] py-3.5 text-[14px] font-light"
                >
                  <span className="min-w-0">
                    {member.name} <span className="text-[#666]">{member.email}</span>
                  </span>
                  <span className="shrink-0 text-[12px] text-[#666]">{member.role}</span>
                </li>
              ))}
            </ul>
            {isOwner && team.kind === "household" ? (
              <form onSubmit={(event) => void addMember(event)} className="mt-2 flex items-end gap-4">
                <label className="block min-w-0 flex-1">
                  <span className={cn(labelClass, "mt-4")}>Email</span>
                  <input
                    className={fieldClass}
                    type="email"
                    placeholder="Google email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                  />
                </label>
                <Button type="submit">Invite</Button>
              </form>
            ) : null}

            <Catalogue
              title="Projects"
              hint="Outcomes that take more than one step, such as Tara AU returns. Not a domain like House or Finance."
              placeholder="New project"
              items={projects}
              onCreate={async (name) => {
                await api.createProject(teamId!, name);
                setNotice("Project saved.");
                await load(teamId!);
              }}
              onArchive={async (id, archived) => {
                await api.updateProject(teamId!, id, { archived });
                setNotice(archived ? "Project archived." : "Project restored.");
                await load(teamId!);
              }}
              setError={setError}
              setNotice={setNotice}
            />

            <Catalogue
              title="Areas"
              hint="Domains of life or work, such as House or Finance. Separate from projects."
              placeholder="New area"
              items={areas}
              onCreate={async (name) => {
                await api.createArea(teamId!, name);
                setNotice("Area saved.");
                await load(teamId!);
              }}
              onArchive={async (id, archived) => {
                await api.updateArea(teamId!, id, { archived });
                setNotice(archived ? "Area archived." : "Area restored.");
                await load(teamId!);
              }}
              setError={setError}
              setNotice={setNotice}
            />

            <h3 className={subheadClass}>Bots</h3>
            <p className="mb-2 text-[13px] font-light text-[#5c5c5c]">
              A registered bot is a name you can put on a task. It does not get a secret. One team token can post for all of them.
            </p>
            <ul>
              {bots.length === 0 ? <li className="py-3.5 text-[13px] text-[#666]">No bots registered yet.</li> : null}
              {bots.map((bot) => (
                <li
                  key={bot.id}
                  className="flex flex-wrap items-baseline justify-between gap-3 border-b border-[#1c1c1c] py-3.5 text-[14px] font-light"
                >
                  <span>
                    {bot.name} <span className="text-[12px] text-[#666]">{bot.agentId}</span>
                  </span>
                  {confirmUnregister === bot.id ? (
                    <span className="flex gap-4">
                      <Button size="sm" variant="danger" onClick={() => void unregister(bot.id)}>
                        Unregister
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmUnregister(null)}>
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setConfirmUnregister(bot.id)}>
                      Unregister
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <form onSubmit={(event) => void registerBot(event)} className="mt-2 flex flex-col gap-4 sm:flex-row sm:items-end">
              <label className="block min-w-0 flex-1">
                <span className={cn(labelClass, "mt-4")}>Name</span>
                <input className={fieldClass} value={botName} onChange={(event) => setBotName(event.target.value)} required />
              </label>
              <label className="block min-w-0 flex-1">
                <span className={cn(labelClass, "mt-4")}>Agent id</span>
                <input className={fieldClass} value={agentId} onChange={(event) => setAgentId(event.target.value)} required />
              </label>
              <Button type="submit">Register</Button>
            </form>

            <h3 className={subheadClass}>Bot tokens</h3>
            <p className="text-[13px] font-light text-[#5c5c5c]">
              A token is a credential for this team, separate from a registered bot. Send it as{" "}
              <code>Authorization: Bearer …</code>. The secret is shown once.
            </p>
            {secret ? (
              <div className="mt-4 border border-[#2a2a2a] border-l-white px-3.5 py-3.5">
                <p className="text-[12px] text-[#c9a35a]">Copy it now. It will not be shown again.</p>
                <pre className="mt-2 overflow-x-auto text-[12px] text-white">{secret}</pre>
                <button
                  type="button"
                  className="mt-3 text-[10px] font-normal uppercase tracking-[0.32em] text-[#8a8a8a] hover:text-white"
                  onClick={() => void navigator.clipboard.writeText(secret)}
                >
                  Copy
                </button>
              </div>
            ) : null}
            <ul className="mt-2">
              {tokens.length === 0 ? <li className="py-3.5 text-[13px] text-[#666]">No tokens.</li> : null}
              {tokens.map((token) => (
                <li
                  key={token.id}
                  className="flex flex-wrap items-baseline justify-between gap-3 border-b border-[#1c1c1c] py-3.5 text-[14px] font-light"
                >
                  <span>
                    {token.label}{" "}
                    <span className="text-[12px] text-[#666]">
                      {token.prefix}… {token.revokedAt ? "· revoked" : ""}
                    </span>
                  </span>
                  {isOwner && !token.revokedAt ? (
                    confirmRevoke === token.id ? (
                      <span className="flex gap-4">
                        <Button size="sm" variant="danger" onClick={() => void revoke(token.id)}>
                          Revoke
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmRevoke(null)}>
                          Cancel
                        </Button>
                      </span>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => setConfirmRevoke(token.id)}>
                        Revoke
                      </Button>
                    )
                  ) : null}
                </li>
              ))}
            </ul>
            {isOwner ? (
              <form onSubmit={(event) => void createToken(event)} className="mt-2 flex items-end gap-4">
                <label className="block min-w-0 flex-1">
                  <span className={cn(labelClass, "mt-4")}>Label</span>
                  <input
                    className={fieldClass}
                    placeholder="Label, e.g. Grok Bot"
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                    required
                  />
                </label>
                <Button type="submit">Mint</Button>
              </form>
            ) : (
              <p className="mt-6 text-[13px] text-[#666]">Ask an owner if you need a new token.</p>
            )}
          </section>
        ) : null}
      </main>
    </div>
  );
}

function Catalogue({
  title,
  hint,
  placeholder,
  items,
  onCreate,
  onArchive,
  setError,
  setNotice,
}: {
  title: string;
  hint: string;
  placeholder: string;
  items: ProjectSummary[];
  onCreate: (name: string) => Promise<void>;
  onArchive: (id: string, archived: boolean) => Promise<void>;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
}) {
  const [draft, setDraft] = useState("");

  async function create(event: React.FormEvent) {
    event.preventDefault();
    const name = draft.trim();
    if (!name) return;
    setNotice(null);
    setError(null);
    try {
      await onCreate(name);
      setDraft("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not add that ${title.toLowerCase().replace(/s$/, "")}.`);
    }
  }

  async function archive(id: string, archived: boolean) {
    setNotice(null);
    setError(null);
    try {
      await onArchive(id, archived);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update that.");
    }
  }

  return (
    <>
      <h3 className={subheadClass}>{title}</h3>
      <p className="mb-2 text-[13px] font-light text-[#5c5c5c]">{hint}</p>
      <ul>
        {items.length === 0 ? <li className="py-3.5 text-[13px] text-[#666]">None yet.</li> : null}
        {items.map((item) => (
          <li
            key={item.id}
            className="flex flex-wrap items-baseline justify-between gap-3 border-b border-[#1c1c1c] py-3.5 text-[14px] font-light"
          >
            <span className={item.archivedAt ? "text-[#666]" : undefined}>
              {item.name}
              {item.archivedAt ? " · archived" : ""}
            </span>
            <Button size="sm" variant="ghost" onClick={() => void archive(item.id, !item.archivedAt)}>
              {item.archivedAt ? "Restore" : "Archive"}
            </Button>
          </li>
        ))}
      </ul>
      <form onSubmit={(event) => void create(event)} className="mt-2 flex items-end gap-4">
        <label className="block min-w-0 flex-1">
          <span className="sr-only">{placeholder}</span>
          <input className={fieldClass} value={draft} placeholder={placeholder} onChange={(event) => setDraft(event.target.value)} />
        </label>
        <Button type="submit">Add</Button>
      </form>
    </>
  );
}
