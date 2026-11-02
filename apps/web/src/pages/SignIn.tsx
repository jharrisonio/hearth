import type { AuthConfig } from "@hearth/shared";
import { useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router";
import { useAuth } from "@/auth";
import { ApiError, api } from "@/lib/api";

const errors: Record<string, string> = {
  google_not_configured: "Google sign-in isn't configured.",
  google: "Google sign-in didn't complete. Try again.",
  state: "That sign-in attempt expired. Try again.",
};

export function SignIn() {
  const { user, loading, setUser } = useAuth();
  const [params] = useSearchParams();
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [error, setError] = useState<string | null>(errors[params.get("error") ?? ""] ?? null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    void api
      .config()
      .then(setConfig)
      .catch(() => setError("Hearth can't reach the server."));
  }, []);

  if (!loading && user) return <Navigate to="/" replace />;

  async function signIn(email: string) {
    setPending(email);
    setError(null);
    try {
      const result = await api.devLogin(email);
      setUser(result.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not sign in.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-black text-white">
      <main className="flex flex-1 flex-col items-center justify-center gap-7 px-8 text-center">
        {config?.google ? (
          <button
            type="button"
            className="text-[15px] font-light tracking-wide hover:underline"
            onClick={() => (window.location.href = "/api/auth/google")}
          >
            Continue with Google
          </button>
        ) : config ? (
          <p className="text-[13px] text-[#a8a8a8]">Google sign-in is off.</p>
        ) : null}
        {config?.devAuth
          ? (config.devUsers ?? []).map((devUser) => (
              <button
                key={devUser.email}
                type="button"
                className="text-[15px] font-light tracking-wide hover:underline disabled:opacity-40"
                disabled={pending != null}
                onClick={() => void signIn(devUser.email)}
              >
                {pending === devUser.email ? "Signing in…" : `Sign in as ${devUser.name}`}
              </button>
            ))
          : null}
        {config?.devAuth && config.devUsers?.length === 0 ? <p className="text-[13px] text-[#a8a8a8]">No seeded users yet.</p> : null}
        {error ? <p className="max-w-sm text-[13px] text-[#a8a8a8]">{error}</p> : null}
      </main>
    </div>
  );
}
