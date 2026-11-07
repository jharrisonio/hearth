import type { AreaSummary, AuthConfig, BotSummary, BotTokenSummary, ConnectorSummary, Member, TeamSummary } from "@hearth/shared";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useAuth } from "@/auth";
import { ShareLink } from "@/components/ShareLink";
import { Button } from "@/components/ui/button";
import { ApiError, api } from "@/lib/api";
import { pageLink, settingsPath } from "@/lib/page-link";
import { cn } from "@/lib/cn";
import { fieldClass, labelClass, pageTitleClass, sectionClass, subheadClass } from "@/lib/field";
import { LIST_KEY } from "@/lib/list";
import { useShell } from "@/shell";

export function Settings() {
  const { teamId } = useParams();
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { chooseList } = useShell();
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [team, setTeam] = useState<TeamSummary | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [tokens, setTokens] = useState<BotTokenSummary[]>([]);
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [connectors, setConnectors] = useState<ConnectorSummary[]>([]);
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
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [config, setConfig] = useState<AuthConfig | null>(null);

  async function load(id: string) {
    setError(null);
    try {
      const [detail, tokenList, botList, areaList, connectorList] = await Promise.all([
        api.team(id),
        api.tokens(id),
        api.bots(id),
        api.areas(id, true),
        api.connectors(id),
      ]);
      setTeam(detail.team);
      setMembers(detail.members);
      setTokens(tokenList.tokens);
      setBots(botList.bots);
      setAreas(areaList.areas);
      setConnectors(connectorList.connectors);
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
          const stored = sessionStorage.getItem(LIST_KEY);
          const id =
            next.find((item) => item.id === stored)?.id ??
            next.find((item) => item.kind === "household")?.id ??
            next[0]?.id;
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
    if (teamId) {
      chooseList(teamId);
      void load(teamId);
    }
  }, [teamId, chooseList]);

  useEffect(() => {
    void api.config().then(setConfig).catch(() => setConfig(null));
  }, []);

  const isOwner = team?.role === "owner";

  function openList(id: string) {
    chooseList(id);
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
      setNotice("Bot retired. Tasks already assigned keep that owner until you reassign them.");
      await load(teamId!);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not unregister that bot.");
    }
  }

  async function saveRename(botId: string) {
    const name = renameValue.trim();
    if (!name) return;
    setNotice(null);
    setError(null);
    try {
      await api.renameBot(teamId!, botId, name);
      setRenaming(null);
      setNotice("Name saved. You do not need to reconnect.");
      await load(teamId!);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not rename that bot.");
    }
  }

  async function disconnect(grantId: string) {
    setError(null);
    try {
      const result = await api.disconnectConnector(teamId!, grantId);
      setConfirmDisconnect(null);
      setNotice(
        result.grantRevoked
          ? "Disconnected. This was the last list, so the connector's token no longer works."
          : "Disconnected from this list. Other lists on that connection stay. Tasks keep their history.",
      );
      await load(teamId!);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not disconnect that connector.");
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
      chooseList(created.id);
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
    <div className="h-full min-h-0 bg-black text-white">
      <main className="hearth-sheet mx-auto h-full w-full max-w-[560px] overflow-y-auto px-7 pb-16 pt-[calc(env(safe-area-inset-top)+3.5rem)]">
        <div className="mb-12 flex items-center justify-between gap-4">
          <h1 className={cn(pageTitleClass, "mb-0")}>Settings</h1>
          <ShareLink
            link={pageLink(
              settingsPath(team?.id ?? teamId ?? null),
              team ? `Settings · ${team.name}` : "Settings",
              window.location.origin,
            )}
          />
        </div>
        {loading ? <p className="text-[10px] uppercase tracking-[0.4em] text-[#a8a8a8]">Loading</p> : null}
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
              <span className="text-[#a8a8a8]">Google</span>
              <button
                type="button"
                className="text-[10px] font-normal uppercase tracking-[0.32em] text-[#a8a8a8] hover:text-white"
                onClick={() => {
                  window.location.href = "/api/auth/google";
                }}
              >
                Connect
              </button>
            </div>
          ) : (
            <div className="flex items-baseline justify-between gap-4 border-b border-[#1c1c1c] py-3.5 text-[14px]">
              <span className="text-[#a8a8a8]">Google sign-in</span>
              <span className="text-[13px] text-[#a8a8a8]">Off</span>
            </div>
          )}
          <button
            type="button"
            className="mt-6 text-[10px] font-normal uppercase tracking-[0.32em] text-[#a8a8a8] hover:text-white"
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
                    <span className="shrink-0 text-[12px] text-[#a8a8a8]">{item.kind}</span>
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
            <p className="mt-4 text-[12px] font-light text-[#a8a8a8]">
              {team.kind === "personal" ? "Personal" : "Household"} / {team.role === "owner" ? "Owner" : "Member"}
            </p>

            <h3 className={subheadClass}>Members</h3>
            <p className="mb-2 text-[13px] font-light text-[#a8a8a8]">
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
                    {member.name} <span className="text-[#a8a8a8]">{member.email}</span>
                  </span>
                  <span className="shrink-0 text-[12px] text-[#a8a8a8]">{member.role}</span>
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
              title="Areas"
              hint="Domains of life or work, such as House or Finance. Projects have their own tab."
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

            <h3 className={subheadClass}>Connectors</h3>
            <p className="mb-2 text-[13px] font-light text-[#a8a8a8]">
              An app such as Grok Bot that you authorised to manage tasks on this list. Add, rename, or retire bot owners
              here. You do not need to reconnect.
            </p>
            {config?.mcpUrl ? (
              <p className="mb-2 break-all text-[12px] font-light text-[#a8a8a8]">
                Connector URL <span className="text-[#cfcfcf]">{config.mcpUrl}</span>. Leave the token blank. Hearth asks
                which lists to allow.
              </p>
            ) : null}
            <ul>
              {connectors.length === 0 ? (
                <li className="py-3.5 text-[13px] text-[#a8a8a8]">No connectors on this list.</li>
              ) : null}
              {connectors.map((connector) => (
                <li
                  key={connector.id}
                  className="flex flex-wrap items-baseline justify-between gap-3 border-b border-[#1c1c1c] py-3.5 text-[14px] font-light"
                >
                  <span>
                    {connector.clientName}{" "}
                    <span className="text-[12px] text-[#a8a8a8]">{connector.createdAt.slice(0, 10)}</span>
                  </span>
                  {isOwner ? (
                    confirmDisconnect === connector.id ? (
                      <span className="flex gap-4">
                        <Button size="sm" variant="danger" onClick={() => void disconnect(connector.id)}>
                          Disconnect
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmDisconnect(null)}>
                          Cancel
                        </Button>
                      </span>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDisconnect(connector.id)}>
                        Disconnect
                      </Button>
                    )
                  ) : null}
                </li>
              ))}
            </ul>

            <h3 className={subheadClass}>Bots</h3>
            <p className="mb-2 text-[13px] font-light text-[#a8a8a8]">
              A registered bot is a name you can put on a task. It does not get a secret. Retiring one unlinks it as an
              owner. Tasks keep that history until you reassign them.
            </p>
            <ul>
              {bots.length === 0 ? <li className="py-3.5 text-[13px] text-[#a8a8a8]">No bots registered yet.</li> : null}
              {bots.map((bot) => (
                <li
                  key={bot.id}
                  className="flex flex-wrap items-baseline justify-between gap-3 border-b border-[#1c1c1c] py-3.5 text-[14px] font-light"
                >
                  {renaming === bot.id ? (
                    <form
                      className="flex min-w-0 flex-1 items-end gap-4"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void saveRename(bot.id);
                      }}
                    >
                      <label className="block min-w-0 flex-1">
                        <span className="sr-only">Name</span>
                        <input className={fieldClass} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} required />
                      </label>
                      <Button type="submit" size="sm">
                        Save
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(null)}>
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    <span>
                      {bot.name} <span className="text-[12px] text-[#a8a8a8]">{bot.agentId}</span>
                    </span>
                  )}
                  {renaming === bot.id ? null : confirmUnregister === bot.id ? (
                    <span className="flex gap-4">
                        <Button size="sm" variant="danger" onClick={() => void unregister(bot.id)}>
                        Retire
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmUnregister(null)}>
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <span className="flex gap-4">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setRenaming(bot.id);
                          setRenameValue(bot.name);
                          setConfirmUnregister(null);
                        }}
                      >
                        Rename
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmUnregister(bot.id)}>
                        Retire
                      </Button>
                    </span>
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
            <p className="text-[13px] font-light text-[#a8a8a8]">
              A token is a credential for this team, separate from a connector. Existing tokens keep working. Send it as{" "}
              <code>Authorization: Bearer …</code>. The secret is shown once.
            </p>
            {secret ? (
              <div className="mt-4 border border-[#2a2a2a] border-l-white px-3.5 py-3.5">
                <p className="text-[12px] text-[#c9a35a]">Copy it now. It will not be shown again.</p>
                <pre className="mt-2 overflow-x-auto text-[12px] text-white">{secret}</pre>
                <button
                  type="button"
                  className="mt-3 text-[10px] font-normal uppercase tracking-[0.32em] text-[#a8a8a8] hover:text-white"
                  onClick={() => void navigator.clipboard.writeText(secret)}
                >
                  Copy
                </button>
              </div>
            ) : null}
            <ul className="mt-2">
              {tokens.length === 0 ? <li className="py-3.5 text-[13px] text-[#a8a8a8]">No tokens.</li> : null}
              {tokens.map((token) => (
                <li
                  key={token.id}
                  className="flex flex-wrap items-baseline justify-between gap-3 border-b border-[#1c1c1c] py-3.5 text-[14px] font-light"
                >
                  <span>
                    {token.label}{" "}
                    <span className="text-[12px] text-[#a8a8a8]">
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
              <p className="mt-6 text-[13px] text-[#a8a8a8]">Ask an owner if you need a new token.</p>
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
  items: AreaSummary[];
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
      <p className="mb-2 text-[13px] font-light text-[#a8a8a8]">{hint}</p>
      <ul>
        {items.length === 0 ? <li className="py-3.5 text-[13px] text-[#a8a8a8]">None yet.</li> : null}
        {items.map((item) => (
          <li
            key={item.id}
            className="flex flex-wrap items-baseline justify-between gap-3 border-b border-[#1c1c1c] py-3.5 text-[14px] font-light"
          >
            <span className={item.archivedAt ? "text-[#a8a8a8]" : undefined}>
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
