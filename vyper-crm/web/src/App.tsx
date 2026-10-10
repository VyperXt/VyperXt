import type { ReactNode } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router";
import { Layout } from "./components/Layout";
import { getToken } from "./lib/api";
import { RealtimeProvider, ToastProvider } from "./lib/app-state";
import { AutomationsPage } from "./pages/Automations";
import { DashboardPage } from "./pages/Dashboard";
import { InboxPage } from "./pages/Inbox";
import { LeadPage } from "./pages/LeadPage";
import { LeadsPage } from "./pages/Leads";
import { LoginPage } from "./pages/Login";
import { PipelinePage } from "./pages/Pipeline";
import { SettingsPage } from "./pages/Settings";

function Private({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  if (!getToken()) return <Navigate to="/login" replace />;
  return <RealtimeProvider onNavigate={(p) => navigate(p)}>{children}</RealtimeProvider>;
}

export function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          element={
            <Private>
              <Layout />
            </Private>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="conversas" element={<InboxPage />} />
          <Route path="conversas/:leadId" element={<InboxPage />} />
          <Route path="funil" element={<PipelinePage />} />
          <Route path="leads" element={<LeadsPage />} />
          <Route path="leads/:id" element={<LeadPage />} />
          <Route path="automacoes" element={<AutomationsPage />} />
          <Route path="configuracoes" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ToastProvider>
  );
}
