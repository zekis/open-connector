import type {
  AgentChatApprovalResult,
  AgentChatInterruptionDecision,
  AgentChatMessage,
  AgentChatProgress,
  AgentChatResponse,
  AgentChatStreamEvent,
  AgentChatToolActivity,
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
  Mic,
  MicOff,
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
  const [session, setSession] = useState<ChatSession>(readStoredChatSession);
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
  const transcriptRef = useRef<HTMLDivElement>(null);
  const voiceClientRef = useRef<SaynaVoiceClient | undefined>(undefined);
  const sendVoiceMessageRef = useRef<(value: string) => Promise<void>>(async () => {});
  const sessionRef = useRef(session);
  const sendingRef = useRef(false);
  const voiceRepliesRef = useRef(false);
  const agentProgressRef = useRef<AgentChatProgress | undefined>(undefined);
  const activeChatAbortRef = useRef<AbortController | undefined>(undefined);
  const queuedVoiceTurnsRef = useRef<string[]>([]);
  const workingCueTimerRef = useRef<number | undefined>(undefined);
  const workingCueIndexRef = useRef(0);
  const spokenMessageIds = useRef(new Set(session.messages.map((message) => message.id)));
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
    sessionRef.current = session;
    storeChatSession(session);
  }, [session]);

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
      if (!response) throw new Error("Chat ended before Claude returned a response.");
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

  function resetChat(): void {
    activeChatAbortRef.current?.abort();
    voiceClientRef.current?.stopSpeaking();
    queuedVoiceTurnsRef.current = [];
    setQueuedVoiceTurnCount(0);
    replaceSession({ messages: [] });
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
    setSession((current) => {
      const updated = typeof next === "function" ? next(current) : next;
      sessionRef.current = updated;
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
        <div className="chat-context-actions">
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
          {messages.length > 0 ? (
            <Button variant="outline" size="sm" onClick={resetChat} disabled={sending || Boolean(pendingApproval)}>
              <Trash2 size={14} aria-hidden="true" />
              New chat
            </Button>
          ) : null}
        </div>
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
                  <span>{agentProgress?.message ?? "Claude is working with your connections…"}</span>
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
                    ? "Ask Claude to find, explain, or do something…"
                    : "Set up Claude to start chatting"
            }
            aria-label="Message Claude"
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
  );
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
            Use ElevenLabs for live speech recognition and spoken Claude replies inside Chat.
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
      <p>
        Claude can answer directly, use actions from your connected applications, or create and manage scheduled Flows.
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
  approvalDecision?: "approve" | "deny" | null | { approvalId: string; decision: "approve" | "deny" };
  onApprovalDecision(decision: "approve" | "deny", approvalId?: string): void;
}): ReactNode {
  const activeApprovalIds = new Set([
    ...(props.activeApprovalIds ?? []),
    ...(props.activeApprovalId ? [props.activeApprovalId] : []),
  ]);
  return (
    <div className="chat-tool-list">
      {props.activities.map((activity) => {
        const approvalId = approvalIdFromToolActivity(activity);
        const waiting = approvalId !== undefined && activeApprovalIds.has(approvalId);
        const decision =
          props.approvalDecision && typeof props.approvalDecision === "object"
            ? props.approvalDecision.approvalId === approvalId
              ? props.approvalDecision.decision
              : null
            : props.approvalDecision;
        return (
          <div className="chat-tool-activity" key={activity.id}>
            {waiting ? (
              <div className="chat-approval-request">
                <Clock3 size={16} aria-hidden="true" />
                <span>
                  <strong>Waiting for approval</strong>
                  <small>Queued without executing. Approve this exact action once.</small>
                </span>
                <div className="chat-approval-actions">
                  <Button
                    size="sm"
                    disabled={decision !== null && decision !== undefined}
                    onClick={() => props.onApprovalDecision("approve", approvalId)}
                  >
                    {decision === "approve" ? <Loader2 className="spin" size={14} /> : <Check size={14} />}
                    {decision === "approve" ? "Approving…" : "Approve once"}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={decision !== null && decision !== undefined}
                    onClick={() => props.onApprovalDecision("deny", approvalId)}
                  >
                    {decision === "deny" ? <Loader2 className="spin" size={14} /> : <X size={14} />}
                    {decision === "deny" ? "Denying…" : "Deny"}
                  </Button>
                  <Button variant="outline" size="sm" asChild>
                    <Link to="/approvals" target="_blank" rel="noreferrer">
                      Open mailbox
                    </Link>
                  </Button>
                </div>
              </div>
            ) : null}
            <details
              className={waiting ? "chat-tool-call pending" : activity.ok ? "chat-tool-call" : "chat-tool-call failed"}
            >
              <summary>
                {waiting ? (
                  <Clock3 size={14} aria-hidden="true" />
                ) : activity.ok ? (
                  <CircleCheck size={14} aria-hidden="true" />
                ) : (
                  <CircleX size={14} aria-hidden="true" />
                )}
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
