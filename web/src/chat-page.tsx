import type {
  ChatConversation,
  ChatDisplayMessage as DisplayMessage,
  ChatHistoryState,
  ChatSession,
} from "./chat-history";
import type {
  AgentChatApprovalResult,
  AgentChatInterruptionDecision,
  AgentChatProgress,
  AgentChatResponse,
  AgentChatStreamEvent,
  AgentChatToolActivity,
  AgentProvider,
  AppData,
  SaynaVoiceConfiguration,
} from "./model";
import type { SaynaVoiceState } from "./sayna-voice";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";

import {
  Bot,
  AudioWaveform,
  Cable,
  Check,
  CircleCheck,
  CircleX,
  Clock3,
  Loader2,
  MessageCircle,
  MessageSquare,
  Mic,
  MicOff,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Settings2,
  Send,
  Trash2,
  Volume2,
  VolumeX,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { apiDelete, apiGet, apiPost, apiPostNdjson, apiPut } from "./api";
import {
  activeChatConversation,
  addChatConversation,
  clearChatHistory,
  deleteChatConversation,
  readStoredChatHistory,
  renameChatConversation,
  replaceChatConversationSession,
  selectChatConversation,
  storeChatHistory,
} from "./chat-history";
import { ChatMarkdown } from "./chat-markdown";
import { evaluatePolicy, policyLayers } from "./policy";
import { SaynaVoiceClient } from "./sayna-voice";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const voiceWorkingCueDelayMs = 1_200;
const voiceWorkingCues = [
  "Hmm, let me check that.",
  "Okay, I'm looking into that.",
  "One moment, I'm checking your connections.",
] as const;
const voiceApprovalCue = "I need your approval before I can continue. You can approve the request here in Chat.";

const suggestions = [
  "Summarize today's important emails.",
  "Create a daily Flow from my connected applications.",
  "Find the latest updates for my active projects.",
];

export function ChatPage(props: { data: AppData; onRefresh(): void }): ReactNode {
  const [history, setHistory] = useState(readStoredChatHistory);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [agentProgress, setAgentProgress] = useState<AgentChatProgress>();
  const [approvalDecision, setApprovalDecision] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceConfiguration, setVoiceConfiguration] = useState<SaynaVoiceConfiguration>();
  const [voiceSettingsOpen, setVoiceSettingsOpen] = useState(false);
  const [voiceState, setVoiceState] = useState<SaynaVoiceState>("offline");
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceReplies, setVoiceReplies] = useState(false);
  const [queuedVoiceTurnCount, setQueuedVoiceTurnCount] = useState(0);
  const [agentProvider, setAgentProvider] = useState<AgentProvider>(
    props.data.agentConnections?.[0]?.provider ?? "claude_code",
  );
  const transcriptRef = useRef<HTMLDivElement>(null);
  const voiceClientRef = useRef<SaynaVoiceClient | undefined>(undefined);
  const sendVoiceMessageRef = useRef<(value: string) => Promise<void>>(async () => {});
  const activeConversation = activeChatConversation(history);
  const session: ChatSession = {
    messages: activeConversation.messages,
    pendingApproval: activeConversation.pendingApproval,
  };
  const sessionRef = useRef(session);
  const sendingRef = useRef(false);
  const voiceRepliesRef = useRef(false);
  const agentProgressRef = useRef<AgentChatProgress | undefined>(undefined);
  const activeChatAbortRef = useRef<AbortController | undefined>(undefined);
  const queuedVoiceTurnsRef = useRef<string[]>([]);
  const workingCueTimerRef = useRef<number | undefined>(undefined);
  const workingCueIndexRef = useRef(0);
  const spokenMessageIds = useRef(new Set(activeConversation.messages.map((message) => message.id)));
  const messages = session.messages;
  const pendingApproval = session.pendingApproval;
  const agentConnections = props.data.agentConnections ?? [];
  const agentConnection = agentConnections.find((connection) => connection.provider === agentProvider);
  const agentName = agentProvider === "openai_codex" ? "Codex" : "Claude";
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
    if (agentConnection || agentConnections.length === 0) return;
    setAgentProvider(agentConnections[0]!.provider);
  }, [agentConnection, agentConnections]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  useEffect(() => {
    const current = activeChatConversation(history);
    sessionRef.current = { messages: current.messages, pendingApproval: current.pendingApproval };
    storeChatHistory(history);
  }, [history]);

  useEffect(() => {
    spokenMessageIds.current = new Set(activeConversation.messages.map((message) => message.id));
  }, [activeConversation.id]);

  useEffect(() => {
    voiceRepliesRef.current = voiceReplies;
  }, [voiceReplies]);

  useEffect(
    () => () => {
      if (workingCueTimerRef.current !== undefined) window.clearTimeout(workingCueTimerRef.current);
      activeChatAbortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void apiGet<SaynaVoiceConfiguration>("/api/agent-chat/voice/config")
      .then((configuration) => {
        if (!cancelled) setVoiceConfiguration(configuration);
      })
      .catch(() => {
        // Cloudflare and older Node runtimes do not expose the optional voice bridge.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!voiceConfiguration?.enabled || !voiceConfiguration.websocketPath) return;
    const client = new SaynaVoiceClient(voiceConfiguration, {
      onStateChange: setVoiceState,
      onListeningChange: setVoiceListening,
      onTranscript: (transcript) => {
        setDraft(transcript.text);
        if (transcript.speechFinal && transcript.text) {
          setDraft("");
          void sendVoiceMessageRef.current(transcript.text);
        }
      },
      onError: setVoiceError,
    });
    voiceClientRef.current = client;
    return () => {
      client.close();
      if (voiceClientRef.current === client) voiceClientRef.current = undefined;
    };
  }, [voiceConfiguration]);

  useEffect(() => {
    const lastMessage = messages.at(-1);
    if (!lastMessage || lastMessage.role !== "assistant" || spokenMessageIds.current.has(lastMessage.id)) return;
    spokenMessageIds.current.add(lastMessage.id);
    if (voiceReplies) void voiceClientRef.current?.speak(pendingApproval ? voiceApprovalCue : lastMessage.content);
  }, [messages, pendingApproval, voiceReplies]);

  useEffect(() => {
    if (sending || pendingApproval || queuedVoiceTurnCount === 0) return;
    const timer = window.setTimeout(drainQueuedVoiceTurn, 0);
    return () => window.clearTimeout(timer);
  }, [pendingApproval, queuedVoiceTurnCount, sending]);

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
          replaceSession((current) => applyApprovalResult(current, result));
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

  async function sendMessage(value: string, source: "text" | "voice" = "text"): Promise<void> {
    const content = value.trim();
    if (!content || !agentConnection) return;
    if (sendingRef.current || sessionRef.current.pendingApproval) {
      if (source === "voice") enqueueVoiceTurn(content);
      return;
    }

    const userMessage: DisplayMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    const nextMessages = [...sessionRef.current.messages, userMessage];
    replaceSession({ messages: nextMessages });
    setDraft("");
    sendingRef.current = true;
    setSending(true);
    setError(null);
    setAgentProgress(undefined);
    agentProgressRef.current = undefined;
    if (voiceRepliesRef.current) startWorkingCue();
    const abortController = new AbortController();
    activeChatAbortRef.current = abortController;
    try {
      let response: AgentChatResponse | undefined;
      await apiPostNdjson<AgentChatStreamEvent>(
        "/api/agent-chat/messages/stream",
        {
          messages: nextMessages.map(({ role, content: messageContent }) => ({ role, content: messageContent })),
          voiceMode: voiceRepliesRef.current || source === "voice",
          timeZone: browserTimeZone(),
          agentProvider,
        },
        (event) => {
          if (event.type === "error") throw new Error(event.error.message);
          if (event.type === "response") {
            response = event.response;
            return;
          }
          stopWorkingCue();
          setAgentProgress(event.progress);
          agentProgressRef.current = event.progress;
          if (voiceRepliesRef.current) void voiceClientRef.current?.speakProgress(event.progress.speech);
        },
        { signal: abortController.signal },
      );
      if (!response) throw new Error(`Chat ended before ${agentName} returned a response.`);
      const assistantMessage: DisplayMessage = {
        ...response.message,
        toolActivity: response.toolActivity,
      };
      replaceSession({
        messages: [...nextMessages, assistantMessage],
        pendingApproval:
          response.status === "waiting_for_approval" && response.approvalId
            ? { approvalId: response.approvalId, assistantMessageId: assistantMessage.id }
            : undefined,
      });
      if (response.status === "waiting_for_approval") props.onRefresh();
    } catch (caught) {
      if (!isAbortError(caught)) {
        setError(caught instanceof Error ? caught.message : "The agent could not answer this message.");
      }
    } finally {
      stopWorkingCue();
      setAgentProgress(undefined);
      agentProgressRef.current = undefined;
      if (activeChatAbortRef.current === abortController) activeChatAbortRef.current = undefined;
      sendingRef.current = false;
      setSending(false);
    }
  }

  sendVoiceMessageRef.current = (value) =>
    sendingRef.current ? handleVoiceInterruption(value) : sendMessage(value, "voice");

  async function handleVoiceInterruption(value: string): Promise<void> {
    const interruption = value.trim();
    const activeRequest = activeChatAbortRef.current;
    if (!interruption || !activeRequest) {
      await sendMessage(interruption, "voice");
      return;
    }
    enqueueVoiceTurn(interruption);
    try {
      const decision = await apiPost<AgentChatInterruptionDecision>("/api/agent-chat/interruptions", {
        messages: sessionRef.current.messages.map(({ role, content }) => ({ role, content })),
        interruption,
        progress: agentProgressRef.current?.message,
        agentProvider,
      });
      if (decision.cancelCurrentTask && activeChatAbortRef.current === activeRequest) activeRequest.abort();
    } catch {
      // Preserve the queued voice turn and let the active request finish when classification is unavailable.
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
      replaceSession((current) => applyApprovalResult(current, result));
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

  function newChat(): void {
    if (sendingRef.current) return;
    prepareConversationChange();
    updateHistory((current) => addChatConversation(current));
  }

  function openChat(id: string): void {
    if (sendingRef.current || id === activeConversation.id) return;
    prepareConversationChange();
    updateHistory((current) => selectChatConversation(current, id));
  }

  function renameChat(conversation: ChatConversation): void {
    const title = window.prompt("Rename chat", conversation.title);
    if (title === null) return;
    updateHistory((current) => renameChatConversation(current, conversation.id, title));
  }

  function deleteChat(conversation: ChatConversation): void {
    if (sendingRef.current || conversation.pendingApproval) return;
    if (conversation.messages.length > 0 && !window.confirm(`Delete “${conversation.title}”?`)) return;
    if (conversation.id === activeConversation.id) prepareConversationChange();
    updateHistory((current) => deleteChatConversation(current, conversation.id));
  }

  function clearHistory(): void {
    if (sendingRef.current || history.conversations.some((conversation) => conversation.pendingApproval)) return;
    if (!window.confirm("Delete every saved chat? This cannot be undone.")) return;
    prepareConversationChange();
    updateHistory(() => clearChatHistory());
  }

  function prepareConversationChange(): void {
    voiceClientRef.current?.stopSpeaking();
    queuedVoiceTurnsRef.current = [];
    setQueuedVoiceTurnCount(0);
    setDraft("");
    setError(null);
    setVoiceError(null);
    setAgentProgress(undefined);
    agentProgressRef.current = undefined;
  }

  function toggleVoiceInput(): void {
    const client = voiceClientRef.current;
    if (!client) return;
    setVoiceError(null);
    setVoiceReplies(true);
    voiceRepliesRef.current = true;
    if (voiceListening) {
      client.stopListening();
      return;
    }
    void client.startListening();
  }

  function toggleVoiceReplies(): void {
    const enabled = !voiceReplies;
    setVoiceReplies(enabled);
    voiceRepliesRef.current = enabled;
    setVoiceError(null);
    if (enabled) void voiceClientRef.current?.preparePlayback();
    else voiceClientRef.current?.stopSpeaking();
  }

  function replaceSession(next: ChatSession | ((current: ChatSession) => ChatSession)): void {
    const conversationId = activeConversation.id;
    updateHistory((current) => replaceChatConversationSession(current, conversationId, next));
  }

  function updateHistory(operation: (current: ChatHistoryState) => ChatHistoryState): void {
    setHistory((current) => {
      const updated = operation(current);
      const active = activeChatConversation(updated);
      sessionRef.current = { messages: active.messages, pendingApproval: active.pendingApproval };
      return updated;
    });
  }

  function enqueueVoiceTurn(value: string): void {
    const queued = queuedVoiceTurnsRef.current;
    if (queued.at(-1) === value) return;
    queued.push(value);
    setQueuedVoiceTurnCount(queued.length);
  }

  function drainQueuedVoiceTurn(): void {
    if (sendingRef.current || sessionRef.current.pendingApproval) return;
    const next = queuedVoiceTurnsRef.current.shift();
    setQueuedVoiceTurnCount(queuedVoiceTurnsRef.current.length);
    if (next) void sendVoiceMessageRef.current(next);
  }

  function startWorkingCue(): void {
    stopWorkingCue();
    workingCueTimerRef.current = window.setTimeout(() => {
      workingCueTimerRef.current = undefined;
      if (!sendingRef.current || !voiceRepliesRef.current) return;
      const cue = voiceWorkingCues[workingCueIndexRef.current % voiceWorkingCues.length]!;
      workingCueIndexRef.current += 1;
      void voiceClientRef.current?.speakProgress(cue);
    }, voiceWorkingCueDelayMs);
  }

  function stopWorkingCue(): void {
    if (workingCueTimerRef.current !== undefined) window.clearTimeout(workingCueTimerRef.current);
    workingCueTimerRef.current = undefined;
  }

  const connectionSummary = `${connectedServices.size} connected application${connectedServices.size === 1 ? "" : "s"}`;
  const actionSummary = `${actionCount} available action${actionCount === 1 ? "" : "s"}`;

  return (
    <div className={historyOpen ? "chat-layout" : "chat-layout history-collapsed"}>
      {historyOpen ? (
        <ChatHistorySidebar
          conversations={history.conversations}
          activeConversationId={activeConversation.id}
          disabled={sending}
          onNew={newChat}
          onSelect={openChat}
          onRename={renameChat}
          onDelete={deleteChat}
          onClear={clearHistory}
        />
      ) : null}
      <div className="chat-page">
        <section className="chat-context-bar" aria-label="Chat agent status">
          <div className="chat-agent-state">
            <span className={agentConnection ? "chat-agent-icon ready" : "chat-agent-icon"}>
              <Bot size={17} aria-hidden="true" />
            </span>
            <span>
              <strong>
                {pendingApproval
                  ? `${agentName} is waiting for approval`
                  : agentConnection
                    ? `${agentName} is ready`
                    : "Agent setup required"}
              </strong>
              <small>
                {agentConnection
                  ? pendingApproval
                    ? "Approving the pending connector action will resume this Chat automatically."
                    : `${connectionSummary} · ${actionSummary}`
                  : "Connect an agent subscription before starting a chat."}
              </small>
            </span>
          </div>
          <div className="chat-context-actions">
            {agentConnections.length > 1 ? (
              <select
                className="agent-model-select"
                aria-label="Chat agent"
                value={agentProvider}
                disabled={sending || Boolean(pendingApproval)}
                onChange={(event) => setAgentProvider(event.target.value as AgentProvider)}
              >
                {agentConnections.map((connection) => (
                  <option key={connection.id} value={connection.provider}>
                    {connection.provider === "openai_codex" ? "OpenAI Codex" : "Claude Code"}
                  </option>
                ))}
              </select>
            ) : null}
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => setHistoryOpen((open) => !open)}
              aria-label={historyOpen ? "Hide chat history" : "Show chat history"}
              title={historyOpen ? "Hide chat history" : "Show chat history"}
            >
              {historyOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
            </Button>
            {voiceConfiguration?.enabled ? (
              <>
                <span className={`chat-voice-state ${voiceState}`} title="Voice input and output provided by Sayna">
                  <AudioWaveform size={14} aria-hidden="true" />
                  {voiceStateLabel(voiceState, voiceListening)}
                  {queuedVoiceTurnCount > 0 ? ` · ${queuedVoiceTurnCount} queued` : ""}
                </span>
                <Button
                  variant="outline"
                  size="icon-sm"
                  onClick={toggleVoiceReplies}
                  aria-label={voiceReplies ? "Disable spoken agent replies" : "Enable spoken agent replies"}
                  aria-pressed={voiceReplies}
                  title={voiceReplies ? "Spoken replies enabled" : "Enable spoken replies"}
                >
                  {voiceReplies ? <Volume2 size={15} /> : <VolumeX size={15} />}
                </Button>
              </>
            ) : null}
            {voiceConfiguration?.available ? (
              <Button
                variant="outline"
                size={voiceConfiguration.configured ? "icon-sm" : "sm"}
                onClick={() => setVoiceSettingsOpen(true)}
                aria-label="Configure Sayna voice"
                title="Configure Sayna voice"
              >
                <Settings2 size={15} aria-hidden="true" />
                {voiceConfiguration.configured ? null : "Set up voice"}
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={newChat} disabled={sending}>
              <Plus size={14} aria-hidden="true" />
              New chat
            </Button>
          </div>
        </section>

        <div className="chat-transcript" ref={transcriptRef} aria-live="polite">
          {messages.length === 0 ? (
            <ChatWelcome
              configured={Boolean(agentConnection)}
              agentName={agentName}
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
                    <span>{agentProgress?.message ?? `${agentName} is working with your connections…`}</span>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>

        <form className="chat-composer" onSubmit={(event) => void submit(event)}>
          {error || voiceError ? <div className="chat-error">{error ?? voiceError}</div> : null}
          <div className="chat-composer-box">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={keyDown}
              placeholder={
                pendingApproval
                  ? "Waiting for the pending approval…"
                  : voiceListening
                    ? "Listening with Sayna…"
                    : agentConnection
                      ? `Ask ${agentName} to find, explain, or do something…`
                      : "Set up an agent to start chatting"
              }
              aria-label={`Message ${agentName}`}
              disabled={!agentConnection || sending || Boolean(pendingApproval)}
              rows={3}
            />
            <div className="chat-composer-actions">
              {voiceConfiguration?.enabled ? (
                <Button
                  type="button"
                  size="icon"
                  variant={voiceListening ? "destructive" : "outline"}
                  onClick={toggleVoiceInput}
                  disabled={!agentConnection || (voiceState === "connecting" && !voiceListening)}
                  aria-label={voiceListening ? "Stop continuous listening" : "Start continuous voice conversation"}
                  aria-pressed={voiceListening}
                  title={voiceListening ? "Stop continuous listening" : "Start continuous voice conversation"}
                >
                  {voiceState === "connecting" && !voiceListening ? (
                    <Loader2 className="spin" size={17} />
                  ) : voiceListening ? (
                    <MicOff size={17} />
                  ) : (
                    <Mic size={17} />
                  )}
                </Button>
              ) : null}
              <Button
                type="submit"
                size="icon"
                disabled={!agentConnection || sending || Boolean(pendingApproval) || !draft.trim()}
                aria-label="Send message"
              >
                {sending ? <Loader2 className="spin" size={17} /> : <Send size={17} />}
              </Button>
            </div>
          </div>
          <p>
            {voiceConfiguration?.enabled ? "Sayna continuous voice · " : ""}Enter to send · Shift+Enter for a new line ·
            Connector actions follow your runtime policy.
          </p>
        </form>
        {voiceConfiguration?.available ? (
          <SaynaVoiceSettingsDialog
            open={voiceSettingsOpen}
            configuration={voiceConfiguration}
            onOpenChange={setVoiceSettingsOpen}
            onSaved={(configuration) => {
              setVoiceConfiguration(configuration);
              setVoiceError(null);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function ChatHistorySidebar(props: {
  conversations: ChatConversation[];
  activeConversationId: string;
  disabled: boolean;
  onNew(): void;
  onSelect(id: string): void;
  onRename(conversation: ChatConversation): void;
  onDelete(conversation: ChatConversation): void;
  onClear(): void;
}): ReactNode {
  const hasSavedMessages = props.conversations.some((conversation) => conversation.messages.length > 0);
  const hasPendingApproval = props.conversations.some((conversation) => conversation.pendingApproval);
  return (
    <aside className="chat-history" aria-label="Chat history">
      <div className="chat-history-header">
        <span>
          <MessageSquare size={16} aria-hidden="true" />
          <strong>Chats</strong>
        </span>
        <Button variant="outline" size="icon-sm" onClick={props.onNew} disabled={props.disabled} aria-label="New chat">
          <Plus size={15} aria-hidden="true" />
        </Button>
      </div>
      <nav className="chat-history-list" aria-label="Saved chats">
        {props.conversations.map((conversation) => {
          const active = conversation.id === props.activeConversationId;
          return (
            <div className={active ? "chat-history-item active" : "chat-history-item"} key={conversation.id}>
              <button
                type="button"
                className="chat-history-select"
                onClick={() => props.onSelect(conversation.id)}
                disabled={props.disabled}
                aria-current={active ? "page" : undefined}
                title={conversation.title}
              >
                <span>{conversation.title}</span>
                <small>
                  {formatHistoryTimestamp(conversation.updatedAt)}
                  {conversation.pendingApproval ? " · Approval pending" : ""}
                </small>
              </button>
              <div className="chat-history-item-actions">
                <button
                  type="button"
                  onClick={() => props.onRename(conversation)}
                  disabled={props.disabled}
                  aria-label={`Rename ${conversation.title}`}
                  title="Rename chat"
                >
                  <Pencil size={13} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => props.onDelete(conversation)}
                  disabled={props.disabled || Boolean(conversation.pendingApproval)}
                  aria-label={`Delete ${conversation.title}`}
                  title={conversation.pendingApproval ? "Resolve the pending approval before deleting" : "Delete chat"}
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </div>
            </div>
          );
        })}
      </nav>
      <button
        type="button"
        className="chat-history-clear"
        onClick={props.onClear}
        disabled={props.disabled || !hasSavedMessages || hasPendingApproval}
        title={hasPendingApproval ? "Resolve pending approvals before clearing history" : "Delete all saved chats"}
      >
        <Trash2 size={13} aria-hidden="true" />
        Clear history
      </button>
    </aside>
  );
}

function formatHistoryTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Saved chat";
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date)
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function SaynaVoiceSettingsDialog(props: {
  open: boolean;
  configuration: SaynaVoiceConfiguration;
  onOpenChange(open: boolean): void;
  onSaved(configuration: SaynaVoiceConfiguration): void;
}): ReactNode {
  const [apiKey, setApiKey] = useState("");
  const [voiceId, setVoiceId] = useState(props.configuration.voiceId);
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setApiKey("");
    setVoiceId(props.configuration.voiceId);
    setStatus(null);
  }, [props.open]);

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy("save");
    setStatus(null);
    try {
      const configuration = await apiPut<SaynaVoiceConfiguration>("/api/agent-chat/voice/settings", {
        apiKey: apiKey.trim(),
        voiceId: voiceId.trim(),
      });
      setApiKey("");
      setStatus("Voice settings saved. Sayna is ready for Chat.");
      props.onSaved(configuration);
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : "Could not save Sayna voice settings.");
    } finally {
      setBusy(null);
    }
  }

  async function remove(): Promise<void> {
    if (!window.confirm("Remove the stored ElevenLabs key and disable voice Chat?")) return;
    setBusy("delete");
    setStatus(null);
    try {
      const configuration = await apiDelete<SaynaVoiceConfiguration>("/api/agent-chat/voice/settings");
      setApiKey("");
      setStatus("ElevenLabs key removed. Voice Chat is disabled.");
      props.onSaved(configuration);
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : "Could not remove Sayna voice settings.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="chat-voice-settings-dialog">
        <DialogHeader>
          <DialogTitle>Sayna voice</DialogTitle>
          <DialogDescription>
            Use ElevenLabs for live speech recognition and spoken agent replies inside Chat.
          </DialogDescription>
        </DialogHeader>
        <form className="chat-voice-settings-form" onSubmit={(event) => void save(event)}>
          <div className="chat-voice-provider">
            <AudioWaveform size={18} aria-hidden="true" />
            <span>
              <strong>ElevenLabs</strong>
              <small>{props.configuration.configured ? "Configured" : "API key required"}</small>
            </span>
          </div>
          <Label className="field">
            <span>{props.configuration.configured ? "Replace API key" : "API key"}</span>
            <Input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={props.configuration.configured ? "Leave blank to keep the current key" : "Paste API key"}
              autoComplete="off"
              required={!props.configuration.configured}
            />
            <small>Stored in the server credential store and never returned to the browser.</small>
          </Label>
          <Label className="field">
            <span>Voice ID</span>
            <Input
              value={voiceId}
              onChange={(event) => setVoiceId(event.target.value)}
              placeholder="ElevenLabs voice ID"
              required
            />
            <small>Uses ElevenLabs Flash v2.5 for low-latency spoken replies.</small>
          </Label>
          {status ? <div className="chat-voice-settings-status">{status}</div> : null}
          <DialogFooter className="chat-voice-settings-actions">
            {props.configuration.configured ? (
              <Button variant="ghost" type="button" disabled={busy !== null} onClick={() => void remove()}>
                {busy === "delete" ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />}
                Remove key
              </Button>
            ) : null}
            <Button
              type="submit"
              disabled={busy !== null || !voiceId.trim() || (!props.configuration.configured && !apiKey.trim())}
            >
              {busy === "save" ? <Loader2 className="spin" size={14} /> : <Check size={14} />}
              Save voice settings
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ChatWelcome(props: { configured: boolean; agentName: string; onSuggestion(value: string): void }): ReactNode {
  if (!props.configured) {
    return (
      <div className="chat-welcome compact">
        <span className="chat-welcome-icon">
          <Bot size={25} aria-hidden="true" />
        </span>
        <h2>Connect your agent</h2>
        <p>Chat uses a subscription agent and model configured for this Open Connector runtime.</p>
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
      <p>
        {props.agentName} can answer directly, use actions from your connected applications, or create and manage
        scheduled Flows.
      </p>
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
  activeApprovalIds?: string[];
  approvalDecision?:
    | "approve"
    | "deny"
    | null
    | { approvalId: string; decision: "approve" | "deny" }
    | { approvalIds: string[]; decision: "approve" | "deny" };
  onApprovalDecision?(decision: "approve" | "deny", approvalId?: string): void;
  onApprovalAll?(decision: "approve" | "deny", approvalIds: string[]): void;
}): ReactNode {
  const activeApprovalIds = new Set([
    ...(props.activeApprovalIds ?? []),
    ...(props.activeApprovalId ? [props.activeApprovalId] : []),
  ]);
  const approvalActivities = props.activities.filter((activity) => approvalIdFromToolActivity(activity));
  const otherActivities = props.activities.filter((activity) => !approvalIdFromToolActivity(activity));
  return (
    <div className="chat-tool-list">
      {approvalActivities.length > 0 && props.onApprovalDecision ? (
        <ChatApprovalActivityGroup
          activities={approvalActivities}
          activeApprovalIds={activeApprovalIds}
          approvalDecision={props.approvalDecision}
          onApprovalDecision={props.onApprovalDecision}
          onApprovalAll={props.onApprovalAll}
        />
      ) : null}
      {otherActivities.map((activity) => (
        <ChatToolCall activity={activity} key={activity.id} />
      ))}
    </div>
  );
}

type ChatApprovalDecision =
  | "approve"
  | "deny"
  | null
  | { approvalId: string; decision: "approve" | "deny" }
  | { approvalIds: string[]; decision: "approve" | "deny" };

function ChatApprovalActivityGroup(props: {
  activities: AgentChatToolActivity[];
  activeApprovalIds: ReadonlySet<string>;
  approvalDecision?: ChatApprovalDecision;
  onApprovalDecision(decision: "approve" | "deny", approvalId?: string): void;
  onApprovalAll?(decision: "approve" | "deny", approvalIds: string[]): void;
}): ReactNode {
  const pending = props.activities.filter((activity) => {
    const approvalId = approvalIdFromToolActivity(activity);
    return approvalId !== undefined && props.activeApprovalIds.has(approvalId);
  });
  const pendingIds = pending.flatMap((activity) => {
    const approvalId = approvalIdFromToolActivity(activity);
    return approvalId ? [approvalId] : [];
  });
  const busy = approvalDecisionIds(props.approvalDecision).length > 0;
  const failed = pending.length === 0 && props.activities.some((activity) => !activity.ok);
  const summary =
    props.activities.length === 1
      ? (props.activities[0]!.actionId ?? props.activities[0]!.label)
      : `${props.activities.length} connector actions`;

  return (
    <div className="chat-approval-group">
      {pending.length > 0 ? (
        <div className="chat-approval-request">
          <Clock3 size={16} aria-hidden="true" />
          <span>
            <strong>{pending.length === 1 ? "Waiting for approval" : `${pending.length} approvals waiting`}</strong>
            <small>Queued without executing. Review these exact actions once.</small>
          </span>
          {pending.length > 1 ? (
            <ul className="chat-approval-items">
              {pending.map((activity) => {
                const approvalId = approvalIdFromToolActivity(activity)!;
                const decision = decisionForApproval(props.approvalDecision, approvalId);
                return (
                  <li key={activity.id}>
                    <span>
                      <strong>{activity.actionId ?? activity.label}</strong>
                      {activity.connectionDisplayName ? <small>{activity.connectionDisplayName}</small> : null}
                    </span>
                    <div>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => props.onApprovalDecision("approve", approvalId)}
                      >
                        {decision === "approve" ? <Loader2 className="spin" size={13} /> : <Check size={13} />}
                        Approve
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => props.onApprovalDecision("deny", approvalId)}
                      >
                        {decision === "deny" ? <Loader2 className="spin" size={13} /> : <X size={13} />}
                        Deny
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
          <div className="chat-approval-actions">
            {pending.length > 1 && props.onApprovalAll ? (
              <>
                <Button size="sm" disabled={busy} onClick={() => props.onApprovalAll!("approve", pendingIds)}>
                  {batchDecision(props.approvalDecision, pendingIds) === "approve" ? (
                    <Loader2 className="spin" size={14} />
                  ) : (
                    <Check size={14} />
                  )}
                  Approve all
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy}
                  onClick={() => props.onApprovalAll!("deny", pendingIds)}
                >
                  {batchDecision(props.approvalDecision, pendingIds) === "deny" ? (
                    <Loader2 className="spin" size={14} />
                  ) : (
                    <X size={14} />
                  )}
                  Deny all
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" disabled={busy} onClick={() => props.onApprovalDecision("approve", pendingIds[0])}>
                  {decisionForApproval(props.approvalDecision, pendingIds[0]!) === "approve" ? (
                    <Loader2 className="spin" size={14} />
                  ) : (
                    <Check size={14} />
                  )}
                  Approve once
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy}
                  onClick={() => props.onApprovalDecision("deny", pendingIds[0])}
                >
                  {decisionForApproval(props.approvalDecision, pendingIds[0]!) === "deny" ? (
                    <Loader2 className="spin" size={14} />
                  ) : (
                    <X size={14} />
                  )}
                  Deny
                </Button>
              </>
            )}
            <Button variant="outline" size="sm" asChild>
              <Link to="/approvals" target="_blank" rel="noreferrer">
                Open mailbox
              </Link>
            </Button>
          </div>
          <details className="chat-approval-payloads">
            <summary>Review {pending.length === 1 ? "request payload" : `${pending.length} request payloads`}</summary>
            <ChatApprovalActivityDetails activities={props.activities} pending />
          </details>
        </div>
      ) : null}
      {pending.length === 0 ? (
        <details className={`chat-tool-call grouped${failed ? " failed" : ""}`}>
          <summary>
            {failed ? <CircleX size={14} aria-hidden="true" /> : <CircleCheck size={14} aria-hidden="true" />}
            <Wrench size={13} aria-hidden="true" />
            <span>{summary}</span>
            <small>{props.activities.length} results</small>
          </summary>
          <ChatApprovalActivityDetails activities={props.activities} />
        </details>
      ) : null}
    </div>
  );
}

function ChatApprovalActivityDetails(props: { activities: AgentChatToolActivity[]; pending?: boolean }): ReactNode {
  return (
    <div className="chat-tool-detail chat-tool-detail-grouped">
      {props.activities.map((activity) => (
        <section key={activity.id}>
          <header>
            {props.pending ? <Clock3 size={13} /> : activity.ok ? <CircleCheck size={13} /> : <CircleX size={13} />}
            <strong>{activity.actionId ?? activity.label}</strong>
            {activity.connectionDisplayName ? <small>{activity.connectionDisplayName}</small> : null}
          </header>
          <strong>Input</strong>
          <pre>{JSON.stringify(activity.input, null, 2)}</pre>
          <strong>{props.pending ? "Queued response" : "Result"}</strong>
          <pre>{JSON.stringify(activity.output, null, 2)}</pre>
        </section>
      ))}
    </div>
  );
}

function ChatToolCall(props: { activity: AgentChatToolActivity }): ReactNode {
  const activity = props.activity;
  return (
    <div className="chat-tool-activity">
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
}

function approvalDecisionIds(decision: ChatApprovalDecision | undefined): string[] {
  if (!decision || typeof decision === "string") return decision ? ["*"] : [];
  return "approvalIds" in decision ? decision.approvalIds : [decision.approvalId];
}

function decisionForApproval(
  decision: ChatApprovalDecision | undefined,
  approvalId: string,
): "approve" | "deny" | undefined {
  if (!decision) return undefined;
  if (typeof decision === "string") return decision;
  return approvalDecisionIds(decision).includes(approvalId) ? decision.decision : undefined;
}

function batchDecision(
  decision: ChatApprovalDecision | undefined,
  approvalIds: string[],
): "approve" | "deny" | undefined {
  if (!decision || typeof decision === "string") return decision || undefined;
  const decisionIds = approvalDecisionIds(decision);
  return approvalIds.every((approvalId) => decisionIds.includes(approvalId)) ? decision.decision : undefined;
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
      ? "The connector action was denied, so the agent stopped this request."
      : "The connector approval expired before the action could run.";
  return {
    messages: session.messages.map((message) =>
      message.id === session.pendingApproval?.assistantMessageId ? { ...message, content } : message,
    ),
  };
}

function browserTimeZone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function isAbortError(value: unknown): boolean {
  return value instanceof DOMException && value.name === "AbortError";
}

function voiceStateLabel(state: SaynaVoiceState, listening: boolean): string {
  if (state === "connecting") return "Sayna connecting";
  if (state === "speaking") return listening ? "Speaking · listening" : "Speaking";
  if (listening) return "Listening continuously";
  if (state === "error") return "Voice error";
  return "Sayna voice";
}
