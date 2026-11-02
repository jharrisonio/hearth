import type { AuthConfig } from "@hearth/shared";
import { useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router";
import { useAuth } from "@/auth";
import { Button } from "@/components/ui/button";
import { ApiError, api } from "@/lib/api";

const errors: Record<string, string> = {
  google_not_configured: "Google sign-in isn't configured. Use a dev sign-in, or set the Google client id and secret.",
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
      .catch(() => setError("Hearth can't reach the server. Check that the API is running."));
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
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-5 py-12">
      <p className="text-xs uppercase tracking-[0.22em] text-muted">Household lists</p>
      <h1 className="mt-2 font-serif text-5xl font-medium tracking-tight">Hearth</h1>
      <p className="mt-3 text-lg text-ink/80">
        The shared list for the people who live here, and the bots that help them.
      </p>
      <section className="mt-8 rounded-3xl border border-line bg-sheet p-5 shadow-sm">
        {config?.google ? (
          <Button className="w-full" onClick={() => (window.location.href = "/api/auth/google")}>
            Continue with Google
          </Button>
        ) : (
          <p className="text-sm text-muted">
            Google sign-in is off until <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> are set.
          </p>
        )}
        {config?.devAuth ? (
          <div className="mt-5 border-t border-line pt-5">
            <p className="text-xs uppercase tracking-[0.16em] text-muted">On this machine</p>
            <div className="mt-3 grid gap-2">
              {(config.devUsers ?? []).map((devUser) => (
                <Button
                  key={devUser.email}
                  variant="secondary"
                  className="w-full justify-between"
                  disabled={pending != null}
                  onClick={() => void signIn(devUser.email)}
                >
                  <span>Sign in as {devUser.name}</span>
                  <span className="text-xs text-muted">{devUser.email}</span>
                </Button>
              ))}
              {config.devUsers?.length === 0 ? <p className="text-sm text-muted">No seeded users yet.</p> : null}
            </div>
          </div>
        ) : null}
        {error ? <p className="mt-4 text-sm text-terracotta">{error}</p> : null}
      </section>
    </main>
  );
}
