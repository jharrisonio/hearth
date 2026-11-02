import type { AuthConfig, BotTokenSummary, Member, TeamSummary } from "@hearth/shared";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useAuth } from "@/auth";
import { CloseIcon } from "@/components/Icons";
import { Button } from "@/components/ui/button";
import { ApiError, api } from "@/lib/api";
import { fieldClass } from "@/lib/field";

export function Settings() {
  const { teamId } = useParams();
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [team, setTeam] = useState<TeamSummary | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [tokens, setTokens] = useState<BotTokenSummary[]>([]);
  const [email, setEmail] = useState("");
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [config, setConfig] = useState<AuthConfig | null>(null);

  async function load(id: string) {
    setError(null);
    try {
      const [detail, tokenList] = await Promise.all([api.team(id), api.tokens(id)]);
      setTeam(detail.team);
      setMembers(detail.members);
      setTokens(tokenList.tokens);
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
  const labelClass = "text-[11px] uppercase tracking-[0.16em] text-white/40";

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
      <Link to="/" aria-label="Close" className="fixed right-8 top-8 z-10 text-white/70 hover:text-white">
        <CloseIcon />
      </Link>
      <main className="mx-auto max-w-md px-8 pb-24 pt-24">
        {loading ? <p className="text-[13px] text-white/40">Loading…</p> : null}
        {error ? <p className="text-[13px] text-white/70">{error}</p> : null}
        {notice ? <p className="mt-4 text-[13px] text-white/70">{notice}</p> : null}

        <section>
          <h2 className={labelClass}>Global</h2>
          <h3 className="mt-8 text-[15px]">Google account</h3>
          <p className="mt-4 text-[15px]">{user?.name}</p>
          <p className="mt-1 text-[13px] text-white/45">{user?.email}</p>
          {config?.google ? (
            <button
              type="button"
              className="mt-6 text-[13px] text-white/70 hover:text-white"
              onClick={() => (window.location.href = "/api/auth/google")}
            >
              Connect Google
            </button>
          ) : (
            <p className="mt-6 text-[13px] text-white/40">Google sign-in is off.</p>
          )}
          <button type="button" className="mt-4 block text-[13px] text-white/45 hover:text-white" onClick={() => void signOut()}>
            Sign out
          </button>
        </section>

        {team ? (
          <section className="mt-16">
            <h2 className={labelClass}>Current list</h2>
            <h3 className="mt-8 text-[15px]">{team.name}</h3>
            <p className="mt-2 text-[13px] text-white/40">
              {team.kind === "personal" ? "Personal" : "Household"} / {team.role === "owner" ? "Owner" : "Member"}
            </p>
            <h4 className={`mt-10 ${labelClass}`}>Members</h4>
            <p className="mt-3 text-[13px] text-white/45">
              {team.kind === "personal"
                ? "A personal list stays with you. Bots you grant can still post here."
                : "Members can see and update household tasks. Only an owner can invite or mint tokens."}
            </p>
            <ul className="mt-6 space-y-4">
              {members.map((member) => (
                <li key={member.userId} className="text-[15px]">
                  {member.name}
                  <span className="mt-1 block text-[12px] text-white/40">{member.email}</span>
                  <span className={`mt-1 block ${labelClass}`}>{member.role}</span>
                </li>
              ))}
            </ul>
            {isOwner && team.kind === "household" ? (
              <form onSubmit={(event) => void addMember(event)} className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-end">
                <label className={`block flex-1 ${labelClass}`}>
                  Email
                  <input
                    className={fieldClass}
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                  />
                </label>
                <Button type="submit">Add member</Button>
              </form>
            ) : null}
            <h4 className={`mt-12 ${labelClass}`}>Bot tokens</h4>
            <p className="mt-3 text-[13px] text-white/45">
              A token is scoped to this team. Send it as <code>Authorization: Bearer …</code>. The secret is shown once.
            </p>
            {secret ? (
              <div className="mt-6 border-y border-white/15 py-4">
                <p className="text-[13px] text-white/70">Shown once. Copy it now.</p>
                <pre className="mt-3 overflow-x-auto text-[12px] text-white">{secret}</pre>
                <button
                  type="button"
                  className="mt-3 text-[12px] uppercase tracking-[0.14em] text-white/50 hover:text-white"
                  onClick={() => void navigator.clipboard.writeText(secret)}
                >
                  Copy
                </button>
              </div>
            ) : null}
            <ul className="mt-6 space-y-4">
              {tokens.length === 0 ? <li className="text-[13px] text-white/35">No tokens yet.</li> : null}
              {tokens.map((token) => (
                <li key={token.id} className="flex flex-wrap items-baseline justify-between gap-3 text-[15px]">
                  <span>
                    {token.label}
                    <span className="mt-1 block text-[12px] text-white/40">
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
              <form onSubmit={(event) => void createToken(event)} className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-end">
                <label className={`block flex-1 ${labelClass}`}>
                  Label
                  <input className={fieldClass} value={label} onChange={(event) => setLabel(event.target.value)} required />
                </label>
                <Button type="submit">Create token</Button>
              </form>
            ) : (
              <p className="mt-6 text-[13px] text-white/40">Ask an owner if you need a new token.</p>
            )}
          </section>
        ) : null}
      </main>
    </div>
  );
}
