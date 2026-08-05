import type { AgentChatMessage, AgentChatResponse, AgentChatToolActivity, AppData } from "./model";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";

import { Bot, Cable, CircleCheck, CircleX, Clock3, Loader2, MessageCircle, Send, Trash2, Wrench } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { apiPost } from "./api";
import { evaluatePolicy, policyLayers } from "./policy";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface DisplayMessage extends AgentChatMessage {
  id: string;
  createdAt: string;
  toolActivity?: AgentChatToolActivity[];
}

const suggestions = [
  "Summarize today's important emails.",
  "What connected applications can you use?",
  "Find the latest updates for my active projects.",
];

export function ChatPage(props: { data: AppData; onRefresh(): void }): ReactNode {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
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

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    await sendMessage(draft);
  }

  async function sendMessage(value: string): Promise<void> {
    const content = value.trim();
    if (!content || sending || !agentConnection) return;

    const userMessage: DisplayMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setDraft("");
    setSending(true);
    setError(null);
    try {
      const response = await apiPost<AgentChatResponse>("/api/agent-chat/messages", {
        messages: nextMessages.map(({ role, content: messageContent }) => ({ role, content: messageContent })),
      });
      setMessages((current) => [
        ...current,
        {
          ...response.message,
          toolActivity: response.toolActivity,
        },
      ]);
      if (response.toolActivity.some((activity) => approvalIdFromToolActivity(activity))) {
        props.onRefresh();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The agent could not answer this message.");
    } finally {
      setSending(false);
    }
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function resetChat(): void {
    setMessages([]);
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
            <strong>{agentConnection ? "Claude is ready" : "Agent setup required"}</strong>
            <small>
              {agentConnection
                ? `${connectionSummary} · ${actionSummary}`
                : "Connect your Claude subscription before starting a chat."}
            </small>
          </span>
        </div>
        {messages.length > 0 ? (
          <Button variant="outline" size="sm" onClick={resetChat} disabled={sending}>
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
              <ChatMessageView key={message.id} message={message} />
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
              agentConnection ? "Ask Claude to find, explain, or do something…" : "Set up Claude to start chatting"
            }
            aria-label="Message Claude"
            disabled={!agentConnection || sending}
            rows={3}
          />
          <Button
            type="submit"
            size="icon"
            disabled={!agentConnection || sending || !draft.trim()}
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

function ChatMessageView(props: { message: DisplayMessage }): ReactNode {
  const assistant = props.message.role === "assistant";
  return (
    <div className={assistant ? "chat-message-row assistant" : "chat-message-row user"}>
      {assistant ? (
        <span className="chat-avatar">
          <Bot size={15} aria-hidden="true" />
        </span>
      ) : null}
      <div className={assistant ? "chat-message-content assistant" : "chat-message-content user"}>
        {props.message.toolActivity?.length ? <ToolActivityList activities={props.message.toolActivity} /> : null}
        <div className={assistant ? "chat-bubble assistant" : "chat-bubble user"}>{props.message.content}</div>
      </div>
    </div>
  );
}

function ToolActivityList(props: { activities: AgentChatToolActivity[] }): ReactNode {
  return (
    <div className="chat-tool-list">
      {props.activities.map((activity) => {
        const approvalId = approvalIdFromToolActivity(activity);
        return (
          <div className="chat-tool-activity" key={activity.id}>
            {approvalId ? (
              <div className="chat-approval-request">
                <Clock3 size={16} aria-hidden="true" />
                <span>
                  <strong>Approval queued</strong>
                  <small>Review the request, then retry this message after approving it.</small>
                </span>
                <Button variant="outline" size="sm" asChild>
                  <Link to="/approvals">Review approval</Link>
                </Button>
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
  if (!isRecord(activity.output) || !isRecord(activity.output.error)) return undefined;
  if (activity.output.error.code !== "approval_required" || !isRecord(activity.output.error.details)) return undefined;
  const approvalId = activity.output.error.details.approvalId;
  return typeof approvalId === "string" && approvalId ? approvalId : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
