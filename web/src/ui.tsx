import type { AppLang } from "./i18n";
import type {
  AppData,
  AgentConnectionSummary,
  AgentModelOption,
  AgentRuntimeSettings,
  ActionApproval,
  ConnectionRecord,
  FlowApproval,
  FlowDefinition,
  FlowRun,
  ConnectionActionPermission,
  OAuthConfig,
  ProviderDefinition,
  RunLogPage,
  RuntimePolicyState,
  RuntimeTokenSummary,
} from "./model";
import type { ThemeMode } from "./theme";
import type { FormEvent, ReactNode } from "react";

import { useI18n, useLang, useTranslate } from "@embra/i18n/react";
import {
  Activity,
  Bot,
  BookOpen,
  Cable,
  Home,
  Inbox,
  KeyRound,
  Loader2,
  MessageCircle,
  Monitor,
  Moon,
  RefreshCw,
  Sun,
  TerminalSquare,
  Workflow,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, NavLink, Route, Routes, useLocation } from "react-router";
import { AccessPage } from "./access-page";
import { ActionsPage } from "./actions-page";
import { AgentsPage } from "./agents-page";
import { ApiError, apiGet, apiPost } from "./api";
import { ApprovalsPage } from "./approvals-page";
import oomolConnectLogoUrl from "./assets/oomol-connect-logo.png";
import { ChatPage } from "./chat-page";
import { FlowBuilderPage } from "./flow-builder-page";
import { FlowsPage } from "./flows-page";
import { persistLang, supportedLangs } from "./i18n";
import { emptyData } from "./model";
import { OverviewPage } from "./overview-page";
import { ProvidersPage } from "./providers-page";
import { ResourcesPage } from "./resources-page";
import { RunsPage } from "./runs-page";
import { InlineError, StatusDot } from "./shared-ui";
import { useThemeMode } from "./theme";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const navItems = [
  { path: "/overview", labelKey: "nav.overview", icon: Home },
  { path: "/providers", labelKey: "nav.providers", icon: Cable },
  { path: "/actions", labelKey: "nav.actions", icon: TerminalSquare },
  { path: "/agents", labelKey: "nav.agents", icon: Bot },
  { path: "/chat", labelKey: "nav.chat", icon: MessageCircle },
  { path: "/flows", labelKey: "nav.flows", icon: Workflow },
  { path: "/approvals", labelKey: "nav.approvals", icon: Inbox },
  { path: "/runs", labelKey: "nav.runs", icon: Activity },
  { path: "/access", labelKey: "nav.access", icon: KeyRound },
  { path: "/resources", labelKey: "nav.docs", icon: BookOpen },
] as const;

const oauthCompletionChannelName = "oomol-connect-oauth";
const oauthCompletedType = "oauth.completed";

const themeOptions = [
  { value: "auto", labelKey: "shell.themeMode.auto", icon: Monitor },
  { value: "light", labelKey: "shell.themeMode.light", icon: Sun },
  { value: "dark", labelKey: "shell.themeMode.dark", icon: Moon },
] as const;

export interface AuthSession {
  adminAuthConfigured: boolean;
  authenticated: boolean;
}

export interface OAuthCompletionMessage {
  type: typeof oauthCompletedType;
  service: string;
}

export function subscribeToOAuthCompletions(onComplete: (message: OAuthCompletionMessage) => void): () => void {
  const handleMessage = (event: MessageEvent<unknown>): void => {
    if (isOAuthCompletionMessage(event.data)) {
      onComplete(event.data);
    }
  };

  if (typeof BroadcastChannel === "undefined") {
    return () => {};
  }

  const channel = new BroadcastChannel(oauthCompletionChannelName);
  channel.addEventListener("message", handleMessage);
  return () => channel.close();
}

function isOAuthCompletionMessage(value: unknown): value is OAuthCompletionMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const message = value as { type?: unknown; service?: unknown };
  return message.type === oauthCompletedType && typeof message.service === "string";
}

export interface LogoutState {
  authSession: AuthSession;
}

export function nextLogoutState(state: LogoutState, succeeded: boolean): LogoutState {
  return succeeded
    ? {
        authSession: { ...state.authSession, authenticated: false },
      }
    : state;
}

export interface AuthLoadState {
  pendingUnlockToken: string;
  authSession: AuthSession;
  locked: boolean;
}

export function nextAuthLoadState(state: AuthLoadState, session: AuthSession): AuthLoadState {
  return {
    pendingUnlockToken: session.authenticated ? "" : state.pendingUnlockToken,
    authSession: session,
    locked: !session.authenticated,
  };
}

export interface RuntimeLoadResult {
  authSession: AuthSession;
  data: AppData;
}

/**
 * Loads dashboard state.
 *
 * The provider catalog is generated at build time and cannot change while the
 * server runs, so `cachedProviders` lets refreshes skip re-downloading it and
 * re-fetch only mutable data.
 */
export async function loadRuntimeData(
  unlockToken: string,
  cachedProviders?: ProviderDefinition[],
): Promise<RuntimeLoadResult> {
  const authSession = await apiGet<AuthSession>("/api/auth/session", { bearerToken: unlockToken });
  if (!authSession.authenticated) {
    return { authSession, data: emptyData };
  }

  const catalogRequest =
    cachedProviders !== undefined ? Promise.resolve(cachedProviders) : apiGet<ProviderDefinition[]>("/api/providers");

  const [
    providers,
    connections,
    oauthConfigs,
    runtimeTokens,
    runtimePolicy,
    runPage,
    flows,
    flowRuns,
    flowApprovals,
    connectionPermissions,
    actionApprovals,
    agentConnections,
    agentSettings,
    agentModels,
  ] = await Promise.all([
    catalogRequest,
    apiGet<ConnectionRecord[]>("/api/connections"),
    apiGet<OAuthConfig[]>("/api/oauth/configs"),
    apiGet<RuntimeTokenSummary[]>("/api/runtime-tokens"),
    apiGet<RuntimePolicyState>("/api/runtime-policy"),
    apiGet<RunLogPage>("/api/runs"),
    apiGet<FlowDefinition[]>("/api/flows"),
    apiGet<FlowRun[]>("/api/flow-runs"),
    apiGet<FlowApproval[]>("/api/flow-approvals"),
    apiGet<ConnectionActionPermission[]>("/api/connection-permissions"),
    apiGet<ActionApproval[]>("/api/action-approvals"),
    apiGet<AgentConnectionSummary[]>("/api/agent-connections"),
    apiGet<AgentRuntimeSettings[]>("/api/agent-settings"),
    apiGet<AgentModelOption[]>("/api/agent-settings/claude_code/models"),
  ]);

  return {
    authSession,
    data: {
      providers,
      connections,
      oauthConfigs,
      runtimeTokens,
      runtimePolicy,
      runs: runPage.items,
      runsNextCursor: runPage.nextCursor,
      flows,
      flowRuns,
      flowApprovals,
      connectionPermissions,
      actionApprovals,
      agentConnections,
      agentSettings,
      agentModels,
    },
  };
}

export function App(): ReactNode {
  const t = useTranslate();
  const { theme, setTheme } = useThemeMode();
  const [data, setData] = useState<AppData>(emptyData);
  const [authSession, setAuthSession] = useState<AuthSession>({
    adminAuthConfigured: false,
    authenticated: true,
  });
  const pendingUnlockToken = useRef("");
  // Catalog is immutable while the server runs, so it is fetched once and
  // reused across refreshes instead of being re-downloaded on every action.
  const cachedProviders = useRef<ProviderDefinition[] | undefined>(undefined);
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [runtimeChecked, setRuntimeChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const refresh = useCallback((): void => {
    setRefreshToken((value) => value + 1);
  }, []);

  useEffect(
    () =>
      subscribeToOAuthCompletions(() => {
        setRefreshToken((value) => value + 1);
      }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const requestUnlockToken = pendingUnlockToken.current;
    setLoading(true);
    loadRuntimeData(requestUnlockToken, cachedProviders.current)
      .then(({ authSession: session, data: nextData }) => {
        if (!cancelled) {
          cachedProviders.current = session.authenticated ? nextData.providers : undefined;
          const nextAuth = nextAuthLoadState(
            {
              pendingUnlockToken: pendingUnlockToken.current,
              authSession,
              locked,
            },
            session,
          );
          pendingUnlockToken.current = nextAuth.pendingUnlockToken;
          setData(nextData);
          setAuthSession(nextAuth.authSession);
          setLocked(nextAuth.locked);
          setError(session.authenticated ? null : requestUnlockToken.trim() ? t("shell.invalidUnlockToken") : null);
        }
      })
      .catch((caught: unknown) => {
        if (cancelled) {
          return;
        }
        if (caught instanceof ApiError && caught.status === 401) {
          pendingUnlockToken.current = "";
          cachedProviders.current = undefined;
          setData(emptyData);
          setAuthSession({ adminAuthConfigured: true, authenticated: false });
          setLocked(true);
          setError(requestUnlockToken.trim() ? t("shell.invalidUnlockToken") : null);
          return;
        }
        setError(caught instanceof Error ? caught.message : t("shell.loadRuntimeFailed"));
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setRuntimeChecked(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [refreshToken, t]);

  function unlock(token: string): void {
    pendingUnlockToken.current = token;
    setLoading(true);
    refresh();
  }

  function logout(): void {
    void apiPost("/api/auth/logout", {})
      .then(() => {
        const next = nextLogoutState({ authSession }, true);
        setAuthSession(next.authSession);
        setError(null);
        refresh();
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : t("shell.logoutFailed"));
      });
  }

  if (locked) {
    return <UnlockView loading={loading} message={error} theme={theme} onThemeChange={setTheme} onUnlock={unlock} />;
  }

  if (!runtimeChecked) {
    return <InitialLoadingView />;
  }

  return (
    <AppShell
      data={data}
      showLogout={authSession.adminAuthConfigured && authSession.authenticated}
      loading={loading}
      error={error}
      theme={theme}
      onRefresh={refresh}
      onThemeChange={setTheme}
      onLogout={logout}
    />
  );
}

function InitialLoadingView(): ReactNode {
  const t = useTranslate();

  return (
    <main className="unlock-screen">
      <div className="loading-panel">
        <Loader2 className="spin" size={16} />
        {t("common.loadingRuntimeData")}
      </div>
    </main>
  );
}

function AppShell(props: {
  data: AppData;
  showLogout: boolean;
  loading: boolean;
  error: string | null;
  theme: ThemeMode;
  onRefresh(): void;
  onThemeChange(theme: ThemeMode): void;
  onLogout(): void;
}): ReactNode {
  const t = useTranslate();
  const location = useLocation();
  const heading = headingForPath(location.pathname);
  const section = location.pathname.split("/").filter(Boolean)[0];
  const isOverviewPage = heading === "overview";
  const isBrowserPage = section === "actions" || section === "runs" || section === "chat";
  const isRunsPage = section === "runs";
  const isChatPage = section === "chat";
  const pendingApprovalCount =
    (props.data.flowApprovals ?? []).filter((approval) => approval.status === "pending").length +
    (props.data.actionApprovals ?? []).filter((approval) => approval.status === "pending").length;
  const mainClassName = [
    isBrowserPage ? "main main-browser" : "main",
    isOverviewPage ? "overview-main" : "",
    isRunsPage ? "runs-main" : "",
    isChatPage ? "chat-main" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const currentNavItem = navItems.find((item) => item.path.slice(1) === heading) ?? navItems[0];
  const CurrentNavIcon = currentNavItem.icon;

  return (
    <div className="app-shell" aria-busy={props.loading}>
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src={oomolConnectLogoUrl} alt="" />
          <div>
            <div className="brand-name">OOMOL Connect</div>
            <div className="brand-subtitle">{t("brand.subtitle")}</div>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label={t("shell.primaryNav")}>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.path}
                className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
                to={item.path}
              >
                <Icon size={16} />
                <span>{t(item.labelKey)}</span>
                {item.path === "/approvals" && pendingApprovalCount > 0 ? (
                  <strong className="nav-count">{pendingApprovalCount > 99 ? "99+" : pendingApprovalCount}</strong>
                ) : null}
              </NavLink>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <LanguageSelect />
          <ThemeControl theme={props.theme} onThemeChange={props.onThemeChange} />
          <div className="runtime-status">
            <StatusDot ok={!props.error} />
            <span>{props.error ? t("common.apiUnavailable") : t("common.runtimeReady")}</span>
          </div>
          <div className="button-row tight">
            <Button variant="outline" size="icon-sm" onClick={props.onRefresh} aria-label={t("shell.refreshData")}>
              {props.loading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            </Button>
            {props.showLogout ? (
              <Button variant="outline" size="sm" onClick={props.onLogout}>
                {t("shell.logout")}
              </Button>
            ) : null}
          </div>
        </div>
      </aside>

      <div className={isBrowserPage ? "main-region main-region-browser" : "main-region"}>
        <header className="shell-header">
          <div className="shell-header-title">
            <CurrentNavIcon size={16} />
            <h1>{t(`shell.headings.${heading}.title`)}</h1>
          </div>
        </header>

        <main className={mainClassName}>
          {props.error ? <InlineError message={props.error} /> : null}

          <Routes>
            <Route index element={<Navigate to="/overview" replace />} />
            <Route path="/overview" element={<OverviewPage data={props.data} onRefresh={props.onRefresh} />} />
            <Route path="/providers" element={<ProvidersPage data={props.data} onRefresh={props.onRefresh} />} />
            <Route
              path="/providers/:service"
              element={<ProvidersPage data={props.data} onRefresh={props.onRefresh} />}
            />
            <Route path="/actions" element={<ActionsPage data={props.data} onRefresh={props.onRefresh} />} />
            <Route path="/actions/:actionId" element={<ActionsPage data={props.data} onRefresh={props.onRefresh} />} />
            <Route path="/agents" element={<AgentsPage data={props.data} onRefresh={props.onRefresh} />} />
            <Route path="/chat" element={<ChatPage data={props.data} onRefresh={props.onRefresh} />} />
            <Route
              path="/runs"
              element={<RunsPage initialRuns={props.data.runs} nextCursor={props.data.runsNextCursor} />}
            />
            <Route path="/flows" element={<FlowsPage data={props.data} onRefresh={props.onRefresh} />} />
            <Route path="/approvals" element={<ApprovalsPage data={props.data} onRefresh={props.onRefresh} />} />
            <Route path="/flows/new" element={<FlowBuilderPage data={props.data} onRefresh={props.onRefresh} />} />
            <Route
              path="/flows/:flowId/edit"
              element={<FlowBuilderPage data={props.data} onRefresh={props.onRefresh} />}
            />
            <Route
              path="/access"
              element={
                <AccessPage
                  providers={props.data.providers}
                  tokens={props.data.runtimeTokens}
                  policy={props.data.runtimePolicy ?? emptyData.runtimePolicy!}
                  onRefresh={props.onRefresh}
                />
              }
            />
            <Route path="/resources" element={<ResourcesPage />} />
            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

export interface UnlockViewProps {
  loading: boolean;
  message: string | null;
  theme: ThemeMode;
  onThemeChange(theme: ThemeMode): void;
  onUnlock(token: string): void;
}

export function UnlockView(props: UnlockViewProps): ReactNode {
  const t = useTranslate();
  const [token, setToken] = useState("");

  function submit(event: FormEvent): void {
    event.preventDefault();
    props.onUnlock(token.trim());
  }

  return (
    <main className="unlock-screen">
      <section className="unlock-panel">
        <div className="brand">
          <img className="brand-mark" src={oomolConnectLogoUrl} alt="" />
          <div>
            <div className="brand-name">OOMOL Connect</div>
            <div className="brand-subtitle">{t("brand.adminAccess")}</div>
          </div>
        </div>
        <LanguageSelect />
        <ThemeControl theme={props.theme} onThemeChange={props.onThemeChange} />
        <form className="form-grid" onSubmit={submit}>
          <Label className="field">
            <span>{t("unlock.token")}</span>
            <Input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoFocus
              autoComplete="current-password"
            />
          </Label>
          <Button
            className="unlock-submit"
            type="submit"
            data-loading={props.loading}
            aria-busy={props.loading}
            disabled={!token.trim() || props.loading}
          >
            <span className="unlock-button-slot">
              <Loader2
                className={props.loading ? "unlock-button-spinner spin" : "unlock-button-spinner idle"}
                size={16}
                aria-hidden="true"
              />
            </span>
            <span>{t("unlock.unlockConsole")}</span>
            <span className="unlock-button-slot" aria-hidden="true" />
          </Button>
        </form>
        {props.message ? (
          <div className="unlock-status" aria-live="polite">
            <InlineError message={props.message} />
          </div>
        ) : null}
      </section>
    </main>
  );
}

function ThemeControl(props: { theme: ThemeMode; onThemeChange(theme: ThemeMode): void }): ReactNode {
  const t = useTranslate();

  return (
    <div className="theme-control" aria-label={t("shell.theme")}>
      <span>{t("shell.theme")}</span>
      <div className="theme-segmented-control" role="radiogroup" aria-label={t("shell.theme")}>
        {themeOptions.map((item) => {
          const Icon = item.icon;
          const selected = props.theme === item.value;
          return (
            <button
              key={item.value}
              type="button"
              className={selected ? "theme-segment active" : "theme-segment"}
              role="radio"
              aria-checked={selected}
              aria-label={t(item.labelKey)}
              title={t(item.labelKey)}
              onClick={() => props.onThemeChange(item.value)}
            >
              <Icon size={14} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function LanguageSelect(): ReactNode {
  const t = useTranslate();
  const i18n = useI18n();
  const lang = useLang() as AppLang;

  function switchLang(nextLang: AppLang): void {
    persistLang(nextLang);
    void i18n.switchLang(nextLang);
  }

  return (
    <div className="language-select">
      <span className="language-select-label">{t("language.label")}</span>
      <Select value={lang} onValueChange={(value) => switchLang(value as AppLang)}>
        <SelectTrigger className="language-select-trigger" size="sm" aria-label={t("language.label")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="language-select-content" position="popper" align="start">
          {supportedLangs.map((item) => (
            <SelectItem key={item} value={item}>
              {t(`language.${item}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function headingForPath(pathname: string): string {
  const section = pathname.split("/").filter(Boolean)[0];
  if (section === "providers") {
    return "providers";
  }
  if (section === "actions") {
    return "actions";
  }
  if (section === "runs") {
    return "runs";
  }
  if (section === "flows") {
    return "flows";
  }
  if (section === "approvals") {
    return "approvals";
  }
  if (section === "agents") {
    return "agents";
  }
  if (section === "chat") {
    return "chat";
  }
  if (section === "access") {
    return "access";
  }
  if (section === "resources") {
    return "resources";
  }
  return "overview";
}
