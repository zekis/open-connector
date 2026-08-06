import type {
  AgentChatApprovalResult,
  AgentChatMessage,
  AgentChatResponse,
  AgentChatToolActivity,
  AppData,
} from "./model";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";

import {
  Bot,
  Cable,
  Check,
  CircleCheck,
  CircleX,
  Clock3,
  Loader2,
  MessageCircle,
  Send,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { apiGet, apiPost } from "./api";
import { ChatMarkdown } from "./chat-markdown";
import { evaluatePolicy, policyLayers } from "./policy";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface DisplayMessage extends AgentChatMessage {
  id: string;
  createdAt: string;
  toolActivity?: AgentChatToolActivity[];
}

interface PendingChatApproval {
  approvalId: string;
  assistantMessageId: string;
}

interface ChatSession {
  messages: DisplayMessage[];
  pendingApproval?: PendingChatApproval;
}

const chatSessionStorageKey = "open-connector.agent-chat-session.v1";

const suggestions = [
  "Summarize today's important emails.",
  "What connected applications can you use?",
  "Find the latest updates for my active projects.",
];

export function ChatPage(props: { data: AppData; onRefresh(): void }): ReactNode {
  const [session, setSession] = useState<ChatSession>(readStoredChatSession);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [approvalDecision, setApprovalDecision] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const messages = session.messages;
  const pendingApproval = session.pendingApproval;
  const agentConnection = props.data.agentConnections?.find((connection) => connection.provider === "claude_code");
  const connectedServices = useMemo(
    () =>
      new Set(
        props.data.connections.filter((connection) => connection.configured).map((connection) => connection.service),
      ),
    [props.data.connections],
  );
  const actionPolicyLayers = useMemo(
    () => (props.data.runtimePolicy ? policyLayers(props.data.runtimePolicy) : []),
    [props.data.runtimePolicy],
  );
  const actionCount = useMemo(
    () =>
      props.data.providers.reduce(
        (total, provider) =>
          total +
          (connectedServices.has(provider.service)
            ? provider.actions.filter(
                (action) =>
                  action.execution.locallyExecutable &&
                  (actionPolicyLayers.length === 0 || evaluatePolicy(action.id, "action", actionPolicyLayers).allowed),
              ).length
            : 0),
        0,
      ),
    [actionPolicyLayers, connectedServices, props.data.providers],
  );

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  useEffect(() => {
    storeChatSession(session);
  }, [session]);

  useEffect(() => {
    if (!pendingApproval) return;
    let cancelled = false;
    let checking = false;
    const check = async (): Promise<void> => {
      if (checking) return;
      checking = true;
      try {
        const result = await apiGet<AgentChatApprovalResult>(`/api/agent-chat/approvals/${pendingApproval.approvalId}`);
        if (!cancelled) {
          setError(null);
          setSession((current) => applyApprovalResult(current, result));
          if (result.response?.status === "waiting_for_approval") props.onRefresh();
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Could not check the pending approval.");
        }
      } finally {
        checking = false;
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 1_500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pendingApproval?.approvalId, props.onRefresh]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    await sendMessage(draft);
  }

  async function sendMessage(value: string): Promise<void> {
    const content = value.trim();
    if (!content || sending || pendingApproval || !agentConnection) return;

    const userMessage: DisplayMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    const nextMessages = [...messages, userMessage];
    setSession({ messages: nextMessages });
    setDraft("");
    setSending(true);
    setError(null);
    try {
      const response = await apiPost<AgentChatResponse>("/api/agent-chat/messages", {
        messages: nextMessages.map(({ role, content: messageContent }) => ({ role, content: messageContent })),
      });
      const assistantMessage: DisplayMessage = {
        ...response.message,
        toolActivity: response.toolActivity,
      };
      setSession({
        messages: [...nextMessages, assistantMessage],
        pendingApproval:
          response.status === "waiting_for_approval" && response.approvalId
            ? { approvalId: response.approvalId, assistantMessageId: assistantMessage.id }
            : undefined,
      });
      if (response.status === "waiting_for_approval") props.onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The agent could not answer this message.");
    } finally {
      setSending(false);
    }
  }

  async function decideApproval(decision: "approve" | "deny"): Promise<void> {
    if (!pendingApproval || approvalDecision) return;
    if (decision === "deny" && !window.confirm("Deny this connector action and stop the waiting Chat?")) return;
    setApprovalDecision(decision);
    setError(null);
    try {
      await apiPost(`/api/action-approvals/${pendingApproval.approvalId}/${decision}`, {});
      const result = await apiGet<AgentChatApprovalResult>(`/api/agent-chat/approvals/${pendingApproval.approvalId}`);
      setSession((current) => applyApprovalResult(current, result));
      props.onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The approval decision could not be recorded.");
      props.onRefresh();
    } finally {
      setApprovalDecision(null);
    }
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function resetChat(): void {
    setSession({ messages: [] });
    setDraft("");
    setError(null);
  }

  const connectionSummary = `${connectedServices.size} connected application${connectedServices.size === 1 ? "" : "s"}`;
  const actionSummary = `${actionCount} available action${actionCount === 1 ? "" : "s"}`;

  return (
    <div className="chat-page">
      <section className="chat-context-bar" aria-label="Chat agent status">
        <div className="chat-agent-state">
          <span className={agentConnection ? "chat-agent-icon ready" : "chat-agent-icon"}>
            <Bot size={17} aria-hidden="true" />
          </span>
          <span>
            <strong>
              {pendingApproval
                ? "Claude is waiting for approval"
                : agentConnection
                  ? "Claude is ready"
                  : "Agent setup required"}
            </strong>
            <small>
              {agentConnection
                ? pendingApproval
                  ? "Approving the pending connector action will resume this Chat automatically."
                  : `${connectionSummary} · ${actionSummary}`
                : "Connect your Claude subscription before starting a chat."}
            </small>
          </span>
        </div>
        {messages.length > 0 ? (
          <Button variant="outline" size="sm" onClick={resetChat} disabled={sending || Boolean(pendingApproval)}>
            <Trash2 size={14} aria-hidden="true" />
            New chat
          </Button>
        ) : null}
      </section>

      <div className="chat-transcript" ref={transcriptRef} aria-live="polite">
        {messages.length === 0 ? (
          <ChatWelcome
            configured={Boolean(agentConnection)}
            onSuggestion={(suggestion) => void sendMessage(suggestion)}
          />
        ) : (
          <div className="chat-message-list">
            {messages.map((message) => (
              <ChatMessageView
                key={message.id}
                message={message}
                activeApprovalId={pendingApproval?.approvalId}
                approvalDecision={approvalDecision}
                onApprovalDecision={(decision) => void decideApproval(decision)}
              />
            ))}
            {sending ? (
              <div className="chat-message-row assistant">
                <span className="chat-avatar">
                  <Bot size={15} aria-hidden="true" />
                </span>
                <div className="chat-bubble assistant thinking">
                  <Loader2 className="spin" size={16} aria-hidden="true" />
                  <span>Claude is working with your connections…</span>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>

      <form className="chat-composer" onSubmit={(event) => void submit(event)}>
        {error ? <div className="chat-error">{error}</div> : null}
        <div className="chat-composer-box">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={keyDown}
            placeholder={
              pendingApproval
                ? "Waiting for the pending approval…"
                : agentConnection
                  ? "Ask Claude to find, explain, or do something…"
                  : "Set up Claude to start chatting"
            }
            aria-label="Message Claude"
            disabled={!agentConnection || sending || Boolean(pendingApproval)}
            rows={3}
          />
          <Button
            type="submit"
            size="icon"
            disabled={!agentConnection || sending || Boolean(pendingApproval) || !draft.trim()}
            aria-label="Send message"
          >
            {sending ? <Loader2 className="spin" size={17} /> : <Send size={17} />}
          </Button>
        </div>
        <p>Enter to send · Shift+Enter for a new line · Connector actions follow your runtime policy.</p>
      </form>
    </div>
  );
}

function ChatWelcome(props: { configured: boolean; onSuggestion(value: string): void }): ReactNode {
  if (!props.configured) {
    return (
      <div className="chat-welcome compact">
        <span className="chat-welcome-icon">
          <Bot size={25} aria-hidden="true" />
        </span>
        <h2>Connect your agent</h2>
        <p>Chat uses the Claude subscription and model configured for this Open Connector runtime.</p>
        <Button asChild>
          <Link to="/agents">Open Agents</Link>
        </Button>
      </div>
    );
  }
  return (
    <div className="chat-welcome">
      <span className="chat-welcome-icon">
        <MessageCircle size={27} aria-hidden="true" />
      </span>
      <h2>What can I help you with?</h2>
      <p>Claude can answer directly or use actions from your connected applications when the request needs them.</p>
      <div className="chat-suggestions">
        {suggestions.map((suggestion) => (
          <button type="button" key={suggestion} onClick={() => props.onSuggestion(suggestion)}>
            <Cable size={14} aria-hidden="true" />
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

function ChatMessageView(props: {
  message: DisplayMessage;
  activeApprovalId?: string;
  approvalDecision: "approve" | "deny" | null;
  onApprovalDecision(decision: "approve" | "deny"): void;
}): ReactNode {
  const assistant = props.message.role === "assistant";
  return (
    <div className={assistant ? "chat-message-row assistant" : "chat-message-row user"}>
      {assistant ? (
        <span className="chat-avatar">
          <Bot size={15} aria-hidden="true" />
        </span>
      ) : null}
      <div className={assistant ? "chat-message-content assistant" : "chat-message-content user"}>
        {props.message.toolActivity?.length ? (
          <ChatToolActivityList
            activities={props.message.toolActivity}
            activeApprovalId={props.activeApprovalId}
            approvalDecision={props.approvalDecision}
            onApprovalDecision={props.onApprovalDecision}
          />
        ) : null}
        <div className={assistant ? "chat-bubble assistant" : "chat-bubble user"}>
          {assistant ? <ChatMarkdown>{props.message.content}</ChatMarkdown> : props.message.content}
        </div>
      </div>
    </div>
  );
}

export function ChatToolActivityList(props: {
  activities: AgentChatToolActivity[];
  activeApprovalId?: string;
  approvalDecision: "approve" | "deny" | null;
  onApprovalDecision(decision: "approve" | "deny"): void;
}): ReactNode {
  return (
    <div className="chat-tool-list">
      {props.activities.map((activity) => {
        const approvalId = approvalIdFromToolActivity(activity);
        const waiting = approvalId !== undefined && approvalId === props.activeApprovalId;
        return (
          <div className="chat-tool-activity" key={activity.id}>
            {waiting ? (
              <div className="chat-approval-request">
                <Clock3 size={16} aria-hidden="true" />
                <span>
                  <strong>Waiting for approval</strong>
                  <small>Claude is paused and will continue automatically after approval.</small>
                </span>
                <div className="chat-approval-actions">
                  <Button
                    size="sm"
                    disabled={props.approvalDecision !== null}
                    onClick={() => props.onApprovalDecision("approve")}
                  >
                    {props.approvalDecision === "approve" ? (
                      <Loader2 className="spin" size={14} />
                    ) : (
                      <Check size={14} />
                    )}
                    {props.approvalDecision === "approve" ? "Approving…" : "Approve and continue"}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={props.approvalDecision !== null}
                    onClick={() => props.onApprovalDecision("deny")}
                  >
                    {props.approvalDecision === "deny" ? <Loader2 className="spin" size={14} /> : <X size={14} />}
                    {props.approvalDecision === "deny" ? "Denying…" : "Deny"}
                  </Button>
                  <Button variant="outline" size="sm" asChild>
                    <Link to="/approvals" target="_blank" rel="noreferrer">
                      Open mailbox
                    </Link>
                  </Button>
                </div>
              </div>
            ) : null}
            <details className={activity.ok ? "chat-tool-call" : "chat-tool-call failed"}>
              <summary>
                {activity.ok ? <CircleCheck size={14} aria-hidden="true" /> : <CircleX size={14} aria-hidden="true" />}
                <Wrench size={13} aria-hidden="true" />
                <span>{activity.type === "search" ? activity.label : activity.actionId}</span>
                {activity.connectionDisplayName ? <small>{activity.connectionDisplayName}</small> : null}
              </summary>
              <div className="chat-tool-detail">
                <strong>Input</strong>
                <pre>{JSON.stringify(activity.input, null, 2)}</pre>
                <strong>Result</strong>
                <pre>{JSON.stringify(activity.output, null, 2)}</pre>
              </div>
            </details>
          </div>
        );
      })}
    </div>
  );
}

export function approvalIdFromToolActivity(activity: AgentChatToolActivity): string | undefined {
  return activity.approvalId;
}

export function applyApprovalResult(session: ChatSession, result: AgentChatApprovalResult): ChatSession {
  if (session.pendingApproval?.approvalId !== result.approvalId) return session;
  if (result.response) {
    const responseMessage: DisplayMessage = {
      ...result.response.message,
      toolActivity: result.response.toolActivity,
    };
    return {
      messages: session.messages.map((message) =>
        message.id === session.pendingApproval?.assistantMessageId ? responseMessage : message,
      ),
      pendingApproval:
        result.response.status === "waiting_for_approval" && result.response.approvalId
          ? {
              approvalId: result.response.approvalId,
              assistantMessageId: responseMessage.id,
            }
          : undefined,
    };
  }
  if (result.status !== "denied" && result.status !== "expired") return session;
  const content =
    result.status === "denied"
      ? "The connector action was denied, so Claude stopped this request."
      : "The connector approval expired before the action could run.";
  return {
    messages: session.messages.map((message) =>
      message.id === session.pendingApproval?.assistantMessageId ? { ...message, content } : message,
    ),
  };
}

function readStoredChatSession(): ChatSession {
  if (typeof window === "undefined") return { messages: [] };
  try {
    const raw = window.sessionStorage.getItem(chatSessionStorageKey);
    if (!raw) return { messages: [] };
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.messages)) return { messages: [] };
    const messages = parsed.messages.filter(isDisplayMessage);
    const pendingApproval = isPendingChatApproval(parsed.pendingApproval) ? parsed.pendingApproval : undefined;
    return pendingApproval && messages.some((message) => message.id === pendingApproval.assistantMessageId)
      ? { messages, pendingApproval }
      : { messages };
  } catch {
    return { messages: [] };
  }
}

function storeChatSession(session: ChatSession): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(chatSessionStorageKey, JSON.stringify(session));
  } catch {
    // Chat remains usable when browser storage is disabled or full.
  }
}

function isDisplayMessage(value: unknown): value is DisplayMessage {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.createdAt === "string" &&
    (value.role === "user" || value.role === "assistant") &&
    typeof value.content === "string" &&
    (value.toolActivity === undefined || Array.isArray(value.toolActivity))
  );
}

function isPendingChatApproval(value: unknown): value is PendingChatApproval {
  return isRecord(value) && typeof value.approvalId === "string" && typeof value.assistantMessageId === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
