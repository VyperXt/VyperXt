import { useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  KanbanSquare,
  LayoutDashboard,
  LogOut,
  MessagesSquare,
  Settings as SettingsIcon,
  Users,
  Workflow,
} from "lucide-react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { setToken } from "../lib/api";
import { useMe, useRealtime } from "../lib/app-state";

const NAV = [
  { to: "/", label: "Painel", icon: LayoutDashboard, end: true },
  { to: "/conversas", label: "Conversas", icon: MessagesSquare },
  { to: "/funil", label: "Funil", icon: KanbanSquare },
  { to: "/leads", label: "Leads", icon: Users },
  { to: "/automacoes", label: "Automações", icon: Workflow },
  { to: "/configuracoes", label: "Configurações", icon: SettingsIcon },
];

export function Layout() {
  const me = useMe();
  const { connected } = useRealtime();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const logout = () => {
    setToken(null);
    qc.clear();
    navigate("/login");
  };

  return (
    <div className="flex h-full flex-col md:flex-row">
      <aside className="flex shrink-0 items-center gap-1 border-b border-slate-200 bg-slate-900 px-2 py-2 text-slate-300 md:w-56 md:flex-col md:items-stretch md:border-r md:border-b-0 md:px-3 md:py-4">
        <div className="mr-2 flex items-center gap-2 px-2 md:mr-0 md:mb-6">
          <div className="grid size-8 place-items-center rounded-lg bg-brand-600 text-white">
            <Bot className="size-5" />
          </div>
          <span className="hidden font-semibold text-white md:inline">Vyper CRM</span>
        </div>
        <nav className="scroll-thin flex flex-1 gap-1 overflow-x-auto md:flex-col md:overflow-visible">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition ${
                  isActive ? "bg-slate-800 text-white" : "hover:bg-slate-800/60 hover:text-white"
                }`
              }
              title={label}
            >
              <Icon className="size-4" />
              <span className="hidden lg:inline">{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-2 md:mt-4 md:border-t md:border-slate-800 md:pt-4">
          <span
            className={`size-2 shrink-0 rounded-full ${connected ? "bg-brand-500" : "bg-slate-500"}`}
            title={connected ? "Tempo real conectado" : "Reconectando..."}
          />
          <div className="hidden min-w-0 flex-1 md:block">
            <p className="truncate text-sm text-white">{me.data?.name}</p>
            <p className="truncate text-xs text-slate-400">{me.data?.email}</p>
          </div>
          <button onClick={logout} className="rounded p-1.5 hover:bg-slate-800 hover:text-white" title="Sair" aria-label="Sair">
            <LogOut className="size-4" />
          </button>
        </div>
      </aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 md:px-6">
      <div>
        <h1 className="text-lg font-semibold">{title}</h1>
        {subtitle && <p className="text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
