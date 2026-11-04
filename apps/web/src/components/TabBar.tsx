import { Link, useLocation } from "react-router";
import { cn } from "@/lib/cn";

const iconClass = "size-[22px]";

function TasksIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={iconClass} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="m4.4 6.2 1.1 1.1 1.8-1.9M4.4 12.2l1.1 1.1 1.8-1.9M4.4 18.2l1.1 1.1 1.8-1.9" />
    </svg>
  );
}

function ProjectsIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={iconClass} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <path d="M3.5 8.2h6.1l1.7 2.1H20.5v8.2a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V8.2Z" />
      <path d="M3.5 8.2V7.2a1 1 0 0 1 1-1h4.2l1.6 2" />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={iconClass} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <path d="M4 8h16v11.2H4z" />
      <path d="M3 8h18L19.4 4.8H4.6L3 8Z" />
      <path d="M10 12.2h4" strokeLinecap="round" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={iconClass} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.2v2.2M12 18.6v2.2M3.2 12h2.2M18.6 12h2.2M5.8 5.8l1.6 1.6M16.6 16.6l1.6 1.6M18.2 5.8l-1.6 1.6M7.4 16.6l-1.6 1.6" />
    </svg>
  );
}

export function TabBar({ settingsTo }: { settingsTo: string }) {
  const path = useLocation().pathname;
  const tabs = [
    { to: "/tasks", label: "Tasks", icon: TasksIcon, active: path === "/tasks" || path.startsWith("/t/") },
    { to: "/projects", label: "Projects", icon: ProjectsIcon, active: path.startsWith("/projects") },
    { to: "/archive", label: "Archive", icon: ArchiveIcon, active: path.startsWith("/archive") },
    {
      to: settingsTo,
      label: "Settings",
      icon: SettingsIcon,
      active: path === "/settings" || path.startsWith("/teams/"),
    },
  ];

  return (
    <nav
      aria-label="Primary"
      className="z-20 shrink-0 border-t border-[#1c1c1c] bg-black pb-[max(0.35rem,env(safe-area-inset-bottom))]"
    >
      <div className="grid grid-cols-4">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <Link
              key={tab.label}
              to={tab.to}
              aria-current={tab.active ? "page" : undefined}
              className={cn(
                "relative flex min-h-14 flex-col items-center justify-center gap-1 px-1 pt-2 text-[9px] font-normal uppercase tracking-[0.14em] transition-colors duration-200",
                tab.active ? "text-white" : "text-[#8a8a8a] hover:text-white",
              )}
            >
              {tab.active ? <span className="absolute inset-x-4 top-0 h-px bg-white" /> : null}
              <Icon />
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
