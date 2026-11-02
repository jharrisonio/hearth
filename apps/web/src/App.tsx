import { Navigate, Route, Routes } from "react-router";
import type { ReactNode } from "react";
import { useAuth } from "@/auth";
import { Home } from "@/pages/Home";
import { Settings } from "@/pages/Settings";
import { SignIn } from "@/pages/SignIn";

export function App() {
  return (
    <Routes>
      <Route path="/signin" element={<SignIn />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <Home />
          </RequireAuth>
        }
      />
      <Route
        path="/teams/:teamId"
        element={
          <RequireAuth>
            <Settings />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return <p className="px-5 py-16 text-center text-muted">Loading your lists…</p>;
  }
  if (!user) return <Navigate to="/signin" replace />;
  return children;
}
