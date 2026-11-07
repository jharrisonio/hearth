import type { OAuthAgent, OAuthRequestPreview, TeamSummary } from "@hearth/shared";
import { useEffect, useState } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router";
import { useAuth } from "@/auth";
import { Button } from "@/components/ui/button";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { fieldClass, hintClass, labelClass, pageTitleClass } from "@/lib/field";

export function Consent() {
  const { user, loading } = useAuth();
  const location = useLocation();
  const [params] = useSearchParams();
  const requestId = params.get("request") ?? "";
  const [preview, setPreview] = useState<OAuthRequestPreview | null>(null);
  const [teams, setTeams] = useState<TeamSummary[] | null>(null);
  const [selected, setSelected] = useState<string[] | null>(null);
  const [roster, setRoster] = useState<string[] | null>(null);
  const [extras, setExtras] = useState<{ agentId: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);

  useEffect(() => {
    if (!user || !requestId) return;
    let cancelled = false;
    void Promise.all([api.oauthRequest(requestId), api.teams()])
      .then(([nextPreview, nextTeams]) => {
        if (cancelled) return;
        setPreview(nextPreview);
        setTeams(nextTeams.teams);
        setSelected([]);
        setRoster(nextPreview.agents.map((agent) => agent.agentId));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Could not open this connection.");
      });
    return () => {
      cancelled = true;
    };
  }, [user, requestId]);

  if (loading) return <div className="min-h-dvh bg-black" />;
  if (!user) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/signin?next=${encodeURIComponent(next)}`} replace />;
  }

  function toggleTeam(id: string) {
    setSelected((current) => {
      const list = current ?? [];
      return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
    });
  }

  function toggleAgent(agentId: string) {
    setRoster((current) => {
      const list = current ?? [];
      return list.includes(agentId) ? list.filter((item) => item !== agentId) : [...list, agentId];
    });
  }

  function chosenBots(): OAuthAgent[] | null {
    const named = (preview?.agents ?? []).filter((agent) => (roster ?? []).includes(agent.agentId));
    const added: OAuthAgent[] = [];
    for (const extra of extras) {
      const agentId = extra.agentId.trim();
      const name = extra.name.trim();
      if (!agentId && !name) continue;
      if (!agentId || !name) return null;
      added.push({ agentId, name });
    }
    return [...named, ...added];
  }

  async function approve() {
    const bots = chosenBots();
    if (!bots) {
      setError("Each bot owner needs a name and an agent id.");
      return;
    }
    if (!selected || selected.length === 0) {
      setError("Choose at least one list.");
      return;
    }
    setPending("approve");
    setError(null);
    try {
      const result = await api.oauthConsent({ request: requestId, teamIds: selected, bots });
      window.location.assign(result.redirectTo);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not authorise that connection.");
      setPending(null);
    }
  }

  async function deny() {
    setPending("deny");
    setError(null);
    try {
      const result = await api.oauthDeny(requestId);
      window.location.assign(result.redirectTo);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not deny that connection.");
      setPending(null);
    }
  }

  const lists = teams ?? [];

  return (
    <div className="min-h-dvh bg-black text-white">
      <main className="hearth-sheet mx-auto min-h-dvh w-full max-w-[560px] px-7 pb-20 pt-[92px]">
        <h1 className={pageTitleClass}>Connect</h1>
        {!requestId ? <p className="text-[13px] text-[#c9a35a]">This connection link is missing.</p> : null}
        {error ? <p className="mb-6 text-[13px] text-[#c9a35a]">{error}</p> : null}
        {requestId && !preview && !error ? <p className="text-[10px] uppercase tracking-[0.4em] text-[#a8a8a8]">Loading</p> : null}
        {preview ? (
          <>
            <p className="text-[15px] font-light leading-relaxed">
              {preview.clientName} wants to manage tasks on your lists.
            </p>
            <p className={hintClass}>
              After you authorise, Hearth sends you back to {preview.redirectHost}.
              {preview.loopback ? " That program is running on this computer." : ""} You can add, rename, or retire bot
              owners later in Settings. You do not need to reconnect.
            </p>
            <p className="mt-3 break-all text-[12px] font-light text-[#a8a8a8]">{preview.redirectUri}</p>

            <h2 className={cn(labelClass, "mt-10")}>Lists</h2>
            <p className={hintClass}>
              Choose lists you belong to. This connection can read and update tasks there. Inviting people and minting
              tokens stays with an owner.
            </p>
            <ul>
              {lists.map((team) => (
                <li key={team.id} className="border-b border-[#1c1c1c]">
                  <label className="flex items-center justify-between gap-4 py-3.5 text-[14px] font-light">
                    <span>
                      {team.name} <span className="text-[12px] text-[#a8a8a8]">{team.kind}</span>
                    </span>
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-white"
                      checked={selected?.includes(team.id) ?? false}
                      onChange={() => toggleTeam(team.id)}
                    />
                  </label>
                </li>
              ))}
              {lists.length === 0 ? <li className="py-3.5 text-[13px] text-[#a8a8a8]">You are not on a list yet.</li> : null}
            </ul>

            <h2 className={cn(labelClass, "mt-10")}>Bot owners</h2>
            <p className={hintClass}>Optional. A name and an agent id, so tasks can be assigned to that agent.</p>
            {preview.agents.length > 0 ? (
              <ul className="mt-2">
                {preview.agents.map((agent) => (
                  <li key={agent.agentId} className="border-b border-[#1c1c1c]">
                    <label className="flex items-center justify-between gap-4 py-3.5 text-[14px] font-light">
                      <span>
                        {agent.name} <span className="text-[12px] text-[#a8a8a8]">{agent.agentId}</span>
                      </span>
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-white"
                        checked={roster?.includes(agent.agentId) ?? false}
                        onChange={() => toggleAgent(agent.agentId)}
                      />
                    </label>
                  </li>
                ))}
              </ul>
            ) : null}
            {extras.map((extra, index) => (
              <div key={index} className="mt-2 flex flex-col gap-4 sm:flex-row sm:items-end">
                <label className="block min-w-0 flex-1">
                  <span className={labelClass}>Name</span>
                  <input
                    className={fieldClass}
                    value={extra.name}
                    onChange={(event) =>
                      setExtras((rows) => rows.map((row, i) => (i === index ? { ...row, name: event.target.value } : row)))
                    }
                  />
                </label>
                <label className="block min-w-0 flex-1">
                  <span className={labelClass}>Agent id</span>
                  <input
                    className={fieldClass}
                    value={extra.agentId}
                    onChange={(event) =>
                      setExtras((rows) => rows.map((row, i) => (i === index ? { ...row, agentId: event.target.value } : row)))
                    }
                  />
                </label>
              </div>
            ))}
            <button
              type="button"
              className="mt-4 text-[10px] font-normal uppercase tracking-[0.32em] text-[#a8a8a8] hover:text-white"
              onClick={() => setExtras((rows) => [...rows, { agentId: "", name: "" }])}
            >
              Add an owner
            </button>

            <div className="mt-12 flex items-center gap-6">
              <Button variant="solid" disabled={pending !== null} onClick={() => void approve()}>
                {pending === "approve" ? "Authorising" : "Authorise"}
              </Button>
              <Button variant="ghost" disabled={pending !== null} onClick={() => void deny()}>
                {pending === "deny" ? "Denying" : "Deny"}
              </Button>
            </div>
          </>
        ) : null}
      </main>
    </div>
  );
}
