import type { BotTokenSummary, Member, TeamSummary } from "@hearth/shared";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { useAuth } from "@/auth";
import { Button } from "@/components/ui/button";
import { ApiError, api } from "@/lib/api";

export function Settings() {
  const { teamId } = useParams();
  const { user } = useAuth();
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
    if (teamId) void load(teamId);
  }, [teamId]);

  if (!teamId) return null;
  const isOwner = team?.role === "owner";

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
    <main className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <Link to="/" className="text-sm text-muted hover:text-ink hover:underline">
        Back to lists
      </Link>
      {loading ? <p className="mt-6 text-muted">Loading team…</p> : null}
      {team ? (
        <>
          <p className="mt-4 text-xs uppercase tracking-[0.16em] text-muted">
            {team.kind === "personal" ? "Personal" : "Household"} · {team.role === "owner" ? "Owner" : "Member"}
          </p>
          <h1 className="font-serif text-4xl">{team.name}</h1>
          <p className="mt-2 text-sm text-muted">Signed in as {user?.name}.</p>
        </>
      ) : null}
      {error ? <p className="mt-4 text-sm text-terracotta">{error}</p> : null}
      {notice ? <p className="mt-4 text-sm text-moss">{notice}</p> : null}

      {team ? (
        <section className="mt-8">
          <h2 className="font-serif text-2xl">People</h2>
          {team.kind === "personal" ? (
            <p className="mt-2 text-sm text-muted">A personal list stays with you. Bots you grant can still post here.</p>
          ) : (
            <p className="mt-2 text-sm text-muted">Members can see and update household tasks. Only an owner can invite or mint tokens.</p>
          )}
          <ul className="mt-3 divide-y divide-line rounded-2xl border border-line bg-sheet">
            {members.map((member) => (
              <li key={member.userId} className="flex items-center justify-between px-4 py-3 text-sm">
                <span>
                  {member.name}
                  <span className="block text-xs text-muted">{member.email}</span>
                </span>
                <span className="text-xs uppercase tracking-wide text-muted">{member.role}</span>
              </li>
            ))}
          </ul>
          {isOwner && team.kind === "household" ? (
            <form onSubmit={(event) => void addMember(event)} className="mt-3 flex flex-col gap-2 sm:flex-row">
              <input
                className="h-10 flex-1 rounded-full border border-line bg-sheet px-4 text-sm outline-none focus:border-teal"
                type="email"
                placeholder="Email they already signed in with"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
              <Button type="submit">Add member</Button>
            </form>
          ) : null}
        </section>
      ) : null}

      {team ? (
        <section className="mt-8">
          <h2 className="font-serif text-2xl">Bot tokens</h2>
          <p className="mt-2 text-sm text-muted">
            A token is scoped to this team. Send it as <code>Authorization: Bearer …</code>. The secret is shown once.
          </p>
          {secret ? (
            <div className="mt-3 rounded-2xl border border-teal/30 bg-teal/5 p-4">
              <p className="text-sm font-medium">Shown once. Copy it now — it cannot be retrieved later.</p>
              <pre className="mt-2 overflow-x-auto rounded-xl bg-ink px-3 py-2 text-xs text-sheet">{secret}</pre>
              <Button
                className="mt-3"
                size="sm"
                variant="secondary"
                onClick={() => void navigator.clipboard.writeText(secret)}
              >
                Copy token
              </Button>
            </div>
          ) : null}
          <ul className="mt-3 divide-y divide-line rounded-2xl border border-line bg-sheet">
            {tokens.length === 0 ? <li className="px-4 py-3 text-sm text-muted">No tokens yet.</li> : null}
            {tokens.map((token) => (
              <li key={token.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <span>
                  {token.label}
                  <span className="block text-xs text-muted">
                    {token.prefix}… {token.revokedAt ? "· revoked" : ""}
                  </span>
                </span>
                {isOwner && !token.revokedAt ? (
                  confirmRevoke === token.id ? (
                    <span className="flex gap-2">
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
            <form onSubmit={(event) => void createToken(event)} className="mt-3 flex flex-col gap-2 sm:flex-row">
              <input
                className="h-10 flex-1 rounded-full border border-line bg-sheet px-4 text-sm outline-none focus:border-teal"
                placeholder="Label, e.g. kitchen bot"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                required
              />
              <Button type="submit">Create token</Button>
            </form>
          ) : (
            <p className="mt-3 text-sm text-muted">Ask an owner if you need a new token.</p>
          )}
        </section>
      ) : null}
    </main>
  );
}
