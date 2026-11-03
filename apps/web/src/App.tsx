import { Navigate, Route, Routes } from "react-router";
import type { ReactNode } from "react";
import { useAuth } from "@/auth";
import { Archive } from "@/pages/Archive";
import { Consent } from "@/pages/Consent";
import { Projects } from "@/pages/Projects";
import { Settings } from "@/pages/Settings";
import { SignIn } from "@/pages/SignIn";
import { Tasks } from "@/pages/Tasks";
import { Shell } from "@/shell";

export function App() {
  return (
    <Routes>
      <Route path="/signin" element={<SignIn />} />
      <Route path="/oauth/consent" element={<Consent />} />
      <Route
        element={
          <RequireAuth>
            <Shell />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Navigate to="/tasks" replace />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:projectId" element={<Projects />} />
        <Route path="/archive" element={<Archive />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/teams/:teamId" element={<Settings />} />
        <Route path="*" element={<Navigate to="/tasks" replace />} />
      </Route>
    </Routes>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="min-h-dvh bg-black" />;
  if (!user) return <Navigate to="/signin" replace />;
  return children;
}
