import type {
  ConnectionRecord,
  InboxAiActionScope,
  InboxConversation,
  InboxConversationSummary,
  InboxLinkedTasks,
  InboxMessage,
  InboxPage,
  InboxPriority,
  InboxProvider,
  ProviderDefinition,
  SynapseWorkspace,
} from "./model";
import type { ChangeEvent, FormEvent, ReactNode } from "react";

import {
  AlertCircle,
  ArrowDownUp,
  Bot,
  BrainCircuit,
  Cable,
  CheckCircle2,
  ExternalLink,
  FileText,
  Loader2,
  ListTodo,
  Mail,
  MessageSquare,
  Paperclip,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Reply as ReplyIcon,
  Search,
  Send,
  Forward as ForwardIcon,
  Sparkles,
  StickyNote,
  Tag,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Link, useNavigate } from "react-router";
import remarkGfm from "remark-gfm";
import { ApiError, apiGet, apiPost, apiPut, apiUpload } from "./api";
import { ProviderIcon as CatalogProviderIcon } from "./shared-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

interface TransitUpload {
  fileId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

type InboxView = "open" | "unread" | "waiting" | "resolved";
type InboxSort = "newest" | "oldest" | "priority";
type ComposerMode = "reply" | "note";

interface AiHandoffTarget {
  scope: InboxAiActionScope;
  targetId?: string;
  label: string;
  instruction?: string;
  preferredConnectionId?: string;
  preferredService?: string;
}

interface InboxPageProps {
  providers: ProviderDefinition[];
}

export function InboxPageView(props: InboxPageProps): ReactNode {
  const navigate = useNavigate();
  const [page, setPage] = useState<InboxPage>({ sources: [], conversations: [], errors: [] });
  const [selectedId, setSelectedId] = useState<string>();
  const [conversation, setConversation] = useState<InboxConversation>();
  const [sourceId, setSourceId] = useState("all");
  const [view, setView] = useState<InboxView>("open");
  const [sort, setSort] = useState<InboxSort>("newest");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [error, setError] = useState<string>();
  const [reply, setReply] = useState("");
  const [replyingTo, setReplyingTo] = useState<InboxMessage>();
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [composerMode, setComposerMode] = useState<ComposerMode>("reply");
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [labelDraft, setLabelDraft] = useState("");
  const [linkedTasks, setLinkedTasks] = useState<InboxLinkedTasks>();
  const [loadingLinkedTasks, setLoadingLinkedTasks] = useState(false);
  const [handoffTarget, setHandoffTarget] = useState<AiHandoffTarget>();
  const [connections, setConnections] = useState<ConnectionRecord[]>([]);
  const [loadingConnections, setLoadingConnections] = useState(false);
  const [handoffConnectionId, setHandoffConnectionId] = useState("");
  const [handoffInstruction, setHandoffInstruction] = useState("");
  const [sendingHandoff, setSendingHandoff] = useState(false);
  const [synapseMessageId, setSynapseMessageId] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const messageList = useRef<HTMLDivElement>(null);
  const providersByService = useMemo(
    () => new Map(props.providers.map((provider) => [provider.service, provider])),
    [props.providers],
  );

  const loadPage = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setLoading(true);
    try {
      const next = await apiGet<InboxPage>("/api/inbox");
      setPage(next);
      setSelectedId((current) =>
        current && next.conversations.some((item) => item.id === current) ? current : next.conversations[0]?.id,
      );
      setError(undefined);
    } catch (loadError) {
      setError(messageForError(loadError, "Could not load the inbox."));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const loadConversation = useCallback(async (id: string, silent = false): Promise<void> => {
    if (!silent) setLoadingConversation(true);
    try {
      const next = await apiGet<InboxConversation>(`/api/inbox/conversations/${encodeURIComponent(id)}`);
      setConversation(next);
      setError(undefined);
      if (next.unread && next.provider === "outlook") {
        void apiPost(`/api/inbox/conversations/${encodeURIComponent(id)}/read`, {})
          .then(() => {
            setPage((current) => ({
              ...current,
              conversations: current.conversations.map((item) => (item.id === id ? { ...item, unread: false } : item)),
            }));
          })
          .catch(() => undefined);
      }
    } catch (loadError) {
      setError(messageForError(loadError, "Could not load this conversation."));
    } finally {
      if (!silent) setLoadingConversation(false);
    }
  }, []);

  useEffect(() => {
    void loadPage();
    const timer = window.setInterval(() => void loadPage(true), 30_000);
    return () => window.clearInterval(timer);
  }, [loadPage]);

  useEffect(() => {
    if (!selectedId) {
      setConversation(undefined);
      return;
    }
    setReplyingTo(undefined);
    void loadConversation(selectedId);
  }, [loadConversation, selectedId]);

  const lastMessage = conversation?.messages.at(-1);
  const lastMessageSignature = lastMessage
    ? `${lastMessage.id}:${lastMessage.createdAt}:${lastMessage.action?.status ?? ""}:${lastMessage.content}`
    : undefined;
  useEffect(() => {
    const element = messageList.current;
    if (!element || !lastMessageSignature) return;
    const frame = window.requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [conversation?.id, lastMessageSignature]);

  useEffect(() => {
    setLinkedTasks(undefined);
    if (!selectedId) return;
    const controller = new AbortController();
    setLoadingLinkedTasks(true);
    void apiGet<InboxLinkedTasks>(`/api/inbox/conversations/${encodeURIComponent(selectedId)}/linked-tasks`, {
      signal: controller.signal,
    })
      .then(setLinkedTasks)
      .catch((loadError) => {
        if (!controller.signal.aborted) {
          setLinkedTasks({ available: true, tasks: [], errors: [messageForError(loadError, "Could not load tasks.")] });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingLinkedTasks(false);
      });
    return () => controller.abort();
  }, [selectedId]);

  const sourceConversations = useMemo(
    () =>
      page.conversations.filter(
        (item) => sourceId === "all" || item.sourceId === sourceId || item.provider === sourceId,
      ),
    [page.conversations, sourceId],
  );

  const visibleConversations = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return sourceConversations
      .filter((item) => matchesView(item, view))
      .filter((item) => {
        if (!normalizedQuery) return true;
        return [
          item.title,
          item.preview,
          item.contextLabel,
          ...item.labels,
          ...item.participants.flatMap((person) => [person.name, person.email]),
        ]
          .filter(Boolean)
          .some((value) => value!.toLowerCase().includes(normalizedQuery));
      })
      .sort(conversationSorter(sort));
  }, [query, sort, sourceConversations, view]);

  async function submitComposer(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!selectedId || (!reply.trim() && (composerMode === "note" || files.length === 0)) || sending) return;
    setSending(true);
    try {
      if (composerMode === "note") {
        const next = await apiPost<InboxConversation>(
          `/api/inbox/conversations/${encodeURIComponent(selectedId)}/notes`,
          { content: reply.trim() },
        );
        adoptConversation(next, selectedId);
        setReply("");
        await loadPage(true);
        return;
      }
      const attachments: TransitUpload[] = [];
      for (const file of files) attachments.push(await apiUpload<TransitUpload>("/api/files", file));
      const next = await apiPost<InboxConversation>(
        `/api/inbox/conversations/${encodeURIComponent(selectedId)}/replies`,
        {
          text: reply.trim(),
          targetMessageId: replyingTo?.id,
          attachments: attachments.map((file) => ({ fileId: file.fileId, name: file.name })),
        },
      );
      adoptConversation(next, selectedId);
      setReply("");
      setReplyingTo(undefined);
      setFiles([]);
      if (fileInput.current) fileInput.current.value = "";
      await loadPage(true);
    } catch (sendError) {
      setError(messageForError(sendError, "Could not send the reply."));
    } finally {
      setSending(false);
    }
  }

  function adoptConversation(next: InboxConversation, previousId: string): void {
    const { messages: _messages, ...summary } = next;
    setConversation(next);
    setSelectedId(next.id);
    setPage((current) => ({
      ...current,
      conversations: current.conversations.map((item) => (item.id === previousId ? summary : item)),
    }));
  }

  async function updateConversation(patch: {
    status?: "open" | "resolved";
    priority?: InboxPriority;
    labels?: string[];
  }) {
    if (!selectedId) return;
    try {
      const next = await apiPut<InboxConversation>(`/api/inbox/conversations/${encodeURIComponent(selectedId)}`, patch);
      adoptConversation(next, selectedId);
      await loadPage(true);
    } catch (updateError) {
      setError(messageForError(updateError, "Could not update the conversation."));
    }
  }

  function addLabel(): void {
    const label = labelDraft.trim();
    if (!conversation || !label) return;
    if (conversation.labels.some((item) => item.toLowerCase() === label.toLowerCase())) {
      setLabelDraft("");
      return;
    }
    setLabelDraft("");
    void updateConversation({ labels: [...conversation.labels, label] });
  }

  function addFiles(event: ChangeEvent<HTMLInputElement>): void {
    const selected = [...(event.target.files ?? [])];
    setFiles((current) => [...current, ...selected].slice(0, 10));
    event.target.value = "";
  }

  function openAiHandoff(target: AiHandoffTarget): void {
    setHandoffTarget(target);
    setHandoffInstruction(target.instruction ?? "");
    if (connections.length) {
      setHandoffConnectionId((current) => chooseHandoffConnection(connections, target, current));
      return;
    }
    if (loadingConnections) return;
    setLoadingConnections(true);
    void apiGet<ConnectionRecord[]>("/api/connections")
      .then((items) => {
        const configured = items.filter((item) => item.configured && item.id);
        setConnections(configured);
        setHandoffConnectionId((current) => chooseHandoffConnection(configured, target, current));
      })
      .catch((loadError) => setError(messageForError(loadError, "Could not load connected accounts.")))
      .finally(() => setLoadingConnections(false));
  }

  async function submitAiHandoff(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!conversation || !selectedId || !handoffTarget || !handoffConnectionId || !handoffInstruction.trim()) return;
    const selectedConnection = connections.find((item) => item.id === handoffConnectionId);
    if (!selectedConnection) return;
    const previousConversation = conversation;
    const createdAt = new Date().toISOString();
    const pendingId = `action:pending:${createdAt}`;
    setSendingHandoff(true);
    setConversation({
      ...conversation,
      messages: [
        ...conversation.messages,
        {
          id: pendingId,
          kind: "action",
          direction: "outbound",
          sender: { name: `AI · ${connectionLabel(selectedConnection)}` },
          content: `Working on: ${handoffInstruction.trim()}`,
          createdAt,
          attachments: [],
          action: {
            scope: handoffTarget.scope,
            status: "running",
            connectionId: handoffConnectionId,
            connectionName: connectionLabel(selectedConnection),
            service: selectedConnection.service,
            instruction: handoffInstruction.trim(),
            activities: [],
          },
        },
      ],
    });
    setHandoffTarget(undefined);
    try {
      const next = await apiPost<InboxConversation>(
        `/api/inbox/conversations/${encodeURIComponent(selectedId)}/ai-actions`,
        {
          scope: handoffTarget.scope,
          targetId: handoffTarget.targetId,
          connectionId: handoffConnectionId,
          instruction: handoffInstruction.trim(),
        },
      );
      adoptConversation(next, selectedId);
    } catch (handoffError) {
      setConversation(previousConversation);
      setError(messageForError(handoffError, "Could not send this context to AI."));
    } finally {
      setSendingHandoff(false);
    }
  }

  function beginReply(message: InboxMessage): void {
    setComposerMode("reply");
    setReplyingTo(message);
    window.requestAnimationFrame(() => composerInput.current?.focus());
  }

  async function sendToSynapse(message: InboxMessage): Promise<void> {
    if (!conversation || synapseMessageId) return;
    setSynapseMessageId(message.id);
    try {
      const workspace = await apiPost<SynapseWorkspace>("/api/synapses", {
        name: `Inbox · ${conversation.title}`.slice(0, 120),
      });
      await apiPost<SynapseWorkspace>(`/api/synapses/${encodeURIComponent(workspace.id)}/nodes`, {
        kind: "artifact",
        artifactKind: conversation.provider === "outlook" ? "email" : "note",
        title: `${conversation.title} · ${message.sender.name}`.slice(0, 240),
        summary: `${message.sender.name} · ${formatMessageTime(message.createdAt)}`,
        content: message.content.slice(0, 40_000),
        position: { x: 120, y: 120 },
        data: {
          inboxConversationId: conversation.id,
          inboxMessageId: message.id,
          provider: conversation.provider,
          sender: message.sender,
          attachments: message.attachments,
        },
      });
      navigate("/synapse");
    } catch (synapseError) {
      setError(messageForError(synapseError, "Could not add this message to Synapse."));
    } finally {
      setSynapseMessageId(undefined);
    }
  }

  const selectedSummary = page.conversations.find((item) => item.id === selectedId);
  const selectedSource = page.sources.find((source) => source.id === conversation?.sourceId);
  const handoffMessage =
    handoffTarget?.scope === "message"
      ? conversation?.messages.find((message) => message.kind === "message" && message.id === handoffTarget.targetId)
      : undefined;
  const handoffContact =
    handoffTarget?.scope === "contact"
      ? conversation?.participants.find(
          (participant) => (participant.email ?? participant.name) === handoffTarget.targetId,
        )
      : undefined;

  return (
    <section className={`unified-inbox${detailsOpen ? "" : " details-collapsed"}`} aria-label="Unified inbox">
      <aside className="inbox-sources">
        <div className="inbox-pane-title">
          <div>
            <strong>Inbox</strong>
            <small>Teams + Outlook</small>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={() => void loadPage()} aria-label="Refresh inbox">
            {loading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
          </Button>
        </div>
        <SourceButton
          active={sourceId === "all"}
          label="All conversations"
          count={page.conversations.length}
          icon={<Users size={15} />}
          onClick={() => setSourceId("all")}
        />
        <div className="inbox-source-heading">Channels</div>
        <SourceButton
          active={sourceId === "microsoft_teams"}
          label="Microsoft Teams"
          count={page.conversations.filter((item) => item.provider === "microsoft_teams").length}
          icon={<MessageSquare size={15} />}
          onClick={() => setSourceId("microsoft_teams")}
        />
        <SourceButton
          active={sourceId === "outlook"}
          label="Outlook"
          count={page.conversations.filter((item) => item.provider === "outlook").length}
          icon={<Mail size={15} />}
          onClick={() => setSourceId("outlook")}
        />
        {page.sources.length ? <div className="inbox-source-heading">Accounts</div> : null}
        {page.sources.map((source) => (
          <SourceButton
            key={source.id}
            active={sourceId === source.id}
            label={source.displayName}
            detail={source.accountLabel}
            count={page.conversations.filter((item) => item.sourceId === source.id).length}
            icon={<ProviderIcon provider={source.provider} />}
            disabled={!source.enabled}
            onClick={() => setSourceId(source.id)}
          />
        ))}
        {page.sources.length === 0 && !loading ? (
          <div className="inbox-connect-empty">
            <p>Connect Outlook or set up a Teams gateway agent to start.</p>
            <Link to="/providers/outlook">Connect Outlook</Link>
            <Link to="/teams-gateway">Set up Teams</Link>
          </div>
        ) : null}
      </aside>

      <aside className="inbox-conversations">
        <div className="inbox-search">
          <Search size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search conversations" />
          {query ? (
            <button type="button" onClick={() => setQuery("")} aria-label="Clear search">
              <X size={14} />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setSort((current) => nextSort(current))}
            aria-label={`Sort conversations: ${sort}`}
            title={`Sort: ${sort}`}
          >
            <ArrowDownUp size={14} />
          </button>
        </div>
        <div className="inbox-view-tabs" role="tablist" aria-label="Conversation status">
          {(["open", "unread", "waiting", "resolved"] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={view === item}
              className={view === item ? "active" : ""}
              onClick={() => setView(item)}
            >
              {item === "open" ? "All" : capitalize(item)}
              <span>{sourceConversations.filter((conversation) => matchesView(conversation, item)).length}</span>
            </button>
          ))}
        </div>
        <div className="inbox-source-errors">
          {page.errors.map((sourceError) => (
            <div className="inbox-source-error" key={sourceError.sourceId}>
              <AlertCircle size={14} />
              <span>{sourceError.message}</span>
            </div>
          ))}
        </div>
        <div className="inbox-list" aria-label="Conversations">
          {visibleConversations.map((item) => (
            <ConversationButton
              key={item.id}
              conversation={item}
              active={selectedId === item.id}
              onClick={() => setSelectedId(item.id)}
            />
          ))}
          {!loading && visibleConversations.length === 0 ? (
            <div className="inbox-list-empty">No conversations match this view.</div>
          ) : null}
        </div>
      </aside>

      <main className="inbox-thread">
        {conversation ? (
          <>
            <header className="inbox-thread-header">
              <ContactAvatar
                label={conversationAvatarLabel(conversation)}
                provider={conversation.provider}
                multiple={conversation.participants.length > 1}
              />
              <div className="inbox-thread-heading">
                <strong>{conversation.title}</strong>
                <span>{conversation.contextLabel}</span>
              </div>
              <span className={`inbox-status ${conversation.status}`}>{conversation.status}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => openAiHandoff({ scope: "conversation", label: conversation.title })}
              >
                <Sparkles size={14} />
                Send to AI
              </Button>
              <Button
                variant={conversation.status === "resolved" ? "outline" : "default"}
                size="sm"
                onClick={() =>
                  void updateConversation({ status: conversation.status === "resolved" ? "open" : "resolved" })
                }
              >
                <CheckCircle2 size={14} />
                {conversation.status === "resolved" ? "Reopen" : "Resolve"}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setDetailsOpen((current) => !current)}
                aria-label={detailsOpen ? "Hide conversation details" : "Show conversation details"}
              >
                {detailsOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
              </Button>
            </header>
            <div ref={messageList} className="inbox-messages" aria-live="polite">
              {loadingConversation ? (
                <div className="inbox-loading">
                  <Loader2 className="spin" size={18} /> Loading conversation…
                </div>
              ) : null}
              {conversation.messages.map((message) => (
                <article className={`inbox-message ${message.direction} ${message.kind}`} key={message.id}>
                  {message.kind === "message" ? (
                    <div className="inbox-message-toolbar" aria-label="Message actions">
                      <button type="button" onClick={() => beginReply(message)}>
                        <ReplyIcon size={12} /> Reply
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          openAiHandoff({
                            scope: "message",
                            targetId: message.id,
                            label: messagePreview(message.content),
                            instruction: "Forward this message to ",
                            preferredConnectionId: selectedSource?.connectionId,
                          })
                        }
                      >
                        <ForwardIcon size={12} /> Forward
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(synapseMessageId)}
                        onClick={() => void sendToSynapse(message)}
                      >
                        {synapseMessageId === message.id ? (
                          <Loader2 className="spin" size={12} />
                        ) : (
                          <BrainCircuit size={12} />
                        )}
                        Synapse
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          openAiHandoff({
                            scope: "message",
                            targetId: message.id,
                            label: messagePreview(message.content),
                            instruction:
                              "Create a task from this message. Preserve the source message ID in the task details.",
                            preferredService: "microsoft_todo",
                          })
                        }
                      >
                        <ListTodo size={12} /> Task
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          openAiHandoff({
                            scope: "message",
                            targetId: message.id,
                            label: messagePreview(message.content),
                          })
                        }
                      >
                        <Sparkles size={12} /> AI
                      </button>
                    </div>
                  ) : null}
                  <div className="inbox-message-meta">
                    {message.kind === "note" ? (
                      <StickyNote size={13} />
                    ) : message.kind === "action" ? (
                      <Bot size={13} />
                    ) : message.direction === "inbound" ? (
                      <ContactAvatar label={message.sender.name} size="small" />
                    ) : (
                      <ContactAvatar label={message.sender.name} size="small" outgoing />
                    )}
                    <strong>{message.sender.name}</strong>
                    <time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time>
                  </div>
                  {message.action ? (
                    <div className={`inbox-ai-action-heading ${message.action.status}`}>
                      <span>
                        <Sparkles size={12} /> {capitalize(message.action.scope)} sent to{" "}
                        {message.action.connectionName}
                      </span>
                      <small>{message.action.instruction}</small>
                    </div>
                  ) : null}
                  <div className="inbox-message-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                  </div>
                  {message.attachments.length ? (
                    <div className="inbox-message-files">
                      {message.attachments.map((attachment) =>
                        attachment.downloadUrl ? (
                          <a key={attachment.id} href={attachment.downloadUrl} target="_blank" rel="noreferrer">
                            <FileText size={14} />
                            <span>{attachment.name}</span>
                            <small>{formatBytes(attachment.sizeBytes)}</small>
                          </a>
                        ) : (
                          <span className="inbox-file-error" key={attachment.id} title={attachment.error}>
                            <AlertCircle size={14} /> {attachment.name}
                          </span>
                        ),
                      )}
                    </div>
                  ) : null}
                  {message.action?.activities.length ? (
                    <div className="inbox-ai-activities">
                      {message.action.activities.map((activity, index) => (
                        <span className={activity.ok ? "success" : "failed"} key={`${activity.label}-${index}`}>
                          {activity.ok ? <CheckCircle2 size={11} /> : <AlertCircle size={11} />}
                          {activity.label}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
            <form className={`inbox-composer ${composerMode}`} onSubmit={(event) => void submitComposer(event)}>
              <div className="inbox-composer-tabs">
                <button
                  className={composerMode === "reply" ? "active" : ""}
                  type="button"
                  onClick={() => setComposerMode("reply")}
                >
                  Reply
                </button>
                <button
                  className={composerMode === "note" ? "active" : ""}
                  type="button"
                  onClick={() => {
                    setComposerMode("note");
                    setReplyingTo(undefined);
                    setFiles([]);
                  }}
                >
                  Private note
                </button>
              </div>
              {composerMode === "reply" && replyingTo ? (
                <div className="inbox-reply-context">
                  <ReplyIcon size={13} />
                  <span>
                    <strong>Replying to {replyingTo.sender.name}</strong>
                    <small>{messagePreview(replyingTo.content)}</small>
                  </span>
                  <button type="button" onClick={() => setReplyingTo(undefined)} aria-label="Clear reply target">
                    <X size={12} />
                  </button>
                </div>
              ) : null}
              {files.length ? (
                <div className="inbox-composer-files">
                  {files.map((file, index) => (
                    <span key={`${file.name}-${index}`}>
                      <Paperclip size={12} /> {file.name}
                      <button
                        type="button"
                        onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                      >
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              <Textarea
                ref={composerInput}
                value={reply}
                onChange={(event) => setReply(event.target.value)}
                placeholder={
                  composerMode === "note"
                    ? "Add a private note (not sent to the contact)…"
                    : `Reply via ${conversation.provider === "outlook" ? "Outlook" : "Teams"}…`
                }
                rows={3}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <div className="inbox-composer-actions">
                {composerMode === "reply" ? (
                  <>
                    <input ref={fileInput} hidden type="file" multiple onChange={addFiles} />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => fileInput.current?.click()}
                      aria-label="Attach files"
                    >
                      <Paperclip size={16} />
                    </Button>
                  </>
                ) : null}
                <span>Enter to send · Shift + Enter for a new line</span>
                <Button
                  type="submit"
                  size="sm"
                  disabled={sending || (!reply.trim() && (composerMode === "note" || files.length === 0))}
                >
                  {sending ? (
                    <Loader2 className="spin" size={15} />
                  ) : composerMode === "note" ? (
                    <StickyNote size={15} />
                  ) : (
                    <Send size={15} />
                  )}
                  {composerMode === "note" ? "Add note" : "Send"}
                </Button>
              </div>
            </form>
          </>
        ) : (
          <div className="inbox-thread-empty">
            <MessageSquare size={28} />
            <strong>{selectedSummary ? "Loading conversation…" : "Choose a conversation"}</strong>
            <span>Teams and Outlook messages appear together here.</span>
          </div>
        )}
      </main>

      <aside className="inbox-details">
        {conversation ? (
          <>
            <div className="inbox-detail-title">Conversation details</div>
            <DetailBlock label="Channel">
              <span className="inbox-provider-line">
                <ProviderIcon provider={conversation.provider} />
                {conversation.provider === "outlook" ? "Outlook" : "Microsoft Teams"}
              </span>
            </DetailBlock>
            <DetailBlock label="Account">
              <strong>{selectedSource?.displayName ?? conversation.contextLabel}</strong>
              {selectedSource?.accountLabel && selectedSource.accountLabel !== selectedSource.displayName ? (
                <small>{selectedSource.accountLabel}</small>
              ) : null}
            </DetailBlock>
            <DetailBlock label="Priority">
              <select
                className={`inbox-priority-select ${conversation.priority}`}
                value={conversation.priority}
                onChange={(event) => void updateConversation({ priority: event.target.value as InboxPriority })}
              >
                <option value="none">No priority</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </DetailBlock>
            <DetailBlock label="Labels">
              <div className="inbox-labels">
                {conversation.labels.map((label) => (
                  <span key={label}>
                    <Tag size={10} /> {label}
                    <button
                      type="button"
                      aria-label={`Remove ${label} label`}
                      onClick={() =>
                        void updateConversation({ labels: conversation.labels.filter((item) => item !== label) })
                      }
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
              <div className="inbox-label-input">
                <input
                  value={labelDraft}
                  maxLength={40}
                  placeholder="Add label"
                  onChange={(event) => setLabelDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addLabel();
                    }
                  }}
                />
                <button type="button" onClick={addLabel} disabled={!labelDraft.trim()}>
                  Add
                </button>
              </div>
            </DetailBlock>
            <DetailBlock label="Participants">
              {conversation.participants.map((participant) => (
                <span className="inbox-person" key={participant.email ?? participant.name}>
                  <ContactAvatar label={participant.name} size="small" />
                  <span>
                    <strong>{participant.name}</strong>
                    {participant.email ? <small>{participant.email}</small> : null}
                  </span>
                  <button
                    type="button"
                    title="Send contact to AI"
                    aria-label={`Send ${participant.name} to AI`}
                    onClick={() =>
                      openAiHandoff({
                        scope: "contact",
                        targetId: participant.email ?? participant.name,
                        label: participant.name,
                      })
                    }
                  >
                    <Sparkles size={13} />
                  </button>
                </span>
              ))}
            </DetailBlock>
            {conversation.provider === "outlook" ? (
              <DetailBlock label="Linked tasks">
                {loadingLinkedTasks ? (
                  <span className="inbox-linked-tasks-state">
                    <Loader2 className="spin" size={13} /> Finding related tasks…
                  </span>
                ) : linkedTasks?.available === false ? (
                  <span className="inbox-linked-tasks-state">Connect Microsoft To Do to find AI-created tasks.</span>
                ) : linkedTasks?.tasks.length ? (
                  <div className="inbox-linked-tasks">
                    {linkedTasks.tasks.map((task) => (
                      <div className={`inbox-linked-task ${task.status}`} key={`${task.connectionId}:${task.id}`}>
                        <span className="inbox-linked-task-icon">
                          {task.status === "completed" ? <CheckCircle2 size={14} /> : <ListTodo size={14} />}
                        </span>
                        <span>
                          <a href="https://to-do.office.com/tasks/" target="_blank" rel="noreferrer">
                            {task.title}
                          </a>
                          <small>
                            {task.taskListName} · {formatTaskStatus(task.status)}
                            {task.dueAt ? ` · Due ${formatTaskDate(task.dueAt)}` : ""}
                          </small>
                        </span>
                        {task.sourceUrl ? (
                          <a
                            className="inbox-linked-task-source"
                            href={task.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            aria-label="Open task source"
                            title="Open source email"
                          >
                            <ExternalLink size={12} />
                          </a>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <span className="inbox-linked-tasks-state">No Microsoft To Do tasks reference this email yet.</span>
                )}
                {linkedTasks?.errors.map((message) => (
                  <small className="inbox-linked-task-error" key={message}>
                    {message}
                  </small>
                ))}
              </DetailBlock>
            ) : null}
            <DetailBlock label="Activity">
              <span>{conversation.messageCount} recent messages</span>
              <span>{conversation.noteCount} private notes</span>
              <span>Updated {formatRelativeTime(conversation.updatedAt)}</span>
            </DetailBlock>
          </>
        ) : null}
      </aside>

      {error ? (
        <div className="inbox-toast" role="alert">
          <AlertCircle size={15} />
          <span>{error}</span>
          <button type="button" onClick={() => setError(undefined)} aria-label="Dismiss error">
            <X size={14} />
          </button>
        </div>
      ) : null}

      <Dialog open={Boolean(handoffTarget)} onOpenChange={(open) => !open && setHandoffTarget(undefined)}>
        <DialogContent className="inbox-handoff-dialog sm:max-w-[min(920px,calc(100vw-2rem))]">
          <DialogHeader>
            <DialogTitle>Send context to AI</DialogTitle>
            <DialogDescription>
              Choose the account the AI may use. The result will appear inline in this conversation.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => void submitAiHandoff(event)}>
            <div className="inbox-handoff-layout">
              <aside className="inbox-handoff-accounts">
                <div>
                  <strong>Connected accounts</strong>
                  <small>AI access is limited to one selection</small>
                </div>
                <div className="inbox-handoff-account-list">
                  {loadingConnections ? (
                    <span className="inbox-handoff-empty">
                      <Loader2 className="spin" size={14} /> Loading accounts…
                    </span>
                  ) : null}
                  {!loadingConnections && connections.length === 0 ? (
                    <span className="inbox-handoff-empty">
                      <Cable size={15} /> No connected accounts
                    </span>
                  ) : null}
                  {connections.map((connection) => {
                    const provider = providersByService.get(connection.service);
                    return (
                      <button
                        className={handoffConnectionId === connection.id ? "selected" : ""}
                        key={connection.id}
                        type="button"
                        onClick={() => setHandoffConnectionId(connection.id ?? "")}
                      >
                        <span className="inbox-handoff-account-icon">
                          {provider ? <CatalogProviderIcon provider={provider} large /> : <Cable size={18} />}
                        </span>
                        <span>
                          <strong>{provider?.displayName ?? providerLabel(connection.service)}</strong>
                          <small>{connectionLabel(connection)}</small>
                        </span>
                        {handoffConnectionId === connection.id ? <CheckCircle2 size={15} /> : null}
                      </button>
                    );
                  })}
                </div>
              </aside>
              <section className="inbox-handoff-compose">
                <div className="inbox-handoff-context-heading">
                  <span>{handoffTarget ? capitalize(handoffTarget.scope) : "Context"} context</span>
                  <strong>{handoffTarget?.label}</strong>
                </div>
                <div className="inbox-handoff-context">
                  {handoffMessage ? (
                    <>
                      <div className="inbox-handoff-message-meta">
                        <ContactAvatar label={handoffMessage.sender.name} size="small" />
                        <strong>{handoffMessage.sender.name}</strong>
                        <time>{formatMessageTime(handoffMessage.createdAt)}</time>
                      </div>
                      <div className="inbox-handoff-message-body">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{handoffMessage.content}</ReactMarkdown>
                      </div>
                      {handoffMessage.attachments.length ? (
                        <small>{handoffMessage.attachments.map((attachment) => attachment.name).join(" · ")}</small>
                      ) : null}
                    </>
                  ) : handoffContact ? (
                    <div className="inbox-handoff-contact">
                      <ContactAvatar label={handoffContact.name} />
                      <span>
                        <strong>{handoffContact.name}</strong>
                        {handoffContact.email ? <small>{handoffContact.email}</small> : null}
                      </span>
                    </div>
                  ) : conversation ? (
                    <div className="inbox-handoff-conversation">
                      <strong>{conversation.title}</strong>
                      <small>{conversation.participants.map((participant) => participant.name).join(", ")}</small>
                      {conversation.messages
                        .filter((message) => message.kind === "message")
                        .slice(-6)
                        .map((message) => (
                          <p key={message.id}>
                            <strong>{message.sender.name}</strong>
                            <span>{messagePreview(message.content)}</span>
                          </p>
                        ))}
                    </div>
                  ) : null}
                </div>
                <label className="inbox-handoff-field">
                  <span>Your message to AI</span>
                  <Textarea
                    value={handoffInstruction}
                    onChange={(event) => setHandoffInstruction(event.target.value)}
                    placeholder="Tell the AI what to do with this context…"
                    rows={5}
                    maxLength={10_000}
                    autoFocus
                  />
                </label>
              </section>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setHandoffTarget(undefined)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!handoffConnectionId || !handoffInstruction.trim() || sendingHandoff}>
                {sendingHandoff ? <Loader2 className="spin" size={14} /> : <Sparkles size={14} />}
                Send to AI
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function SourceButton(props: {
  active: boolean;
  label: string;
  detail?: string;
  count: number;
  icon: ReactNode;
  disabled?: boolean;
  onClick(): void;
}): ReactNode {
  return (
    <button
      className={`inbox-source-button${props.active ? " active" : ""}`}
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <span className="inbox-source-icon">{props.icon}</span>
      <span>
        <strong>{props.label}</strong>
        {props.detail ? <small>{props.detail}</small> : null}
      </span>
      <span className="inbox-source-count">{props.count}</span>
    </button>
  );
}

function ConversationButton(props: {
  conversation: InboxConversationSummary;
  active: boolean;
  onClick(): void;
}): ReactNode {
  const item = props.conversation;
  return (
    <button className={`inbox-list-item${props.active ? " active" : ""}`} type="button" onClick={props.onClick}>
      <ContactAvatar
        label={conversationAvatarLabel(item)}
        provider={item.provider}
        multiple={item.participants.length > 1}
      />
      <div className="inbox-list-copy">
        <div>
          <strong>{item.title}</strong>
          <time>{formatRelativeTime(item.updatedAt)}</time>
        </div>
        <span className="inbox-list-context">{item.contextLabel}</span>
        <p>{item.preview || "Attachment"}</p>
        {item.labels.length || item.usedConnections.length || item.priority !== "none" || item.status === "waiting" ? (
          <span className="inbox-list-tags">
            {item.priority !== "none" ? (
              <small className={`inbox-priority ${item.priority}`}>{item.priority}</small>
            ) : null}
            {item.status === "waiting" ? <small className="inbox-waiting">Waiting</small> : null}
            {item.labels.slice(0, 2).map((label) => (
              <small className="inbox-label" key={label}>
                {label}
              </small>
            ))}
            {item.usedConnections.slice(0, 3).map((connection) => (
              <small
                className="inbox-connection-badge"
                key={connection.connectionId}
                title={`Used ${providerLabel(connection.service)} connection: ${connection.connectionName}`}
              >
                <Sparkles size={9} /> {providerLabel(connection.service)}
              </small>
            ))}
            {item.usedConnections.length > 3 ? (
              <small className="inbox-connection-badge">+{item.usedConnections.length - 3}</small>
            ) : null}
          </span>
        ) : null}
      </div>
      {item.unread ? <span className="inbox-unread" title="Unread" /> : null}
    </button>
  );
}

function ContactAvatar(props: {
  label: string;
  provider?: InboxProvider;
  size?: "small";
  multiple?: boolean;
  outgoing?: boolean;
}): ReactNode {
  const tone = avatarTone(props.label);
  return (
    <span
      className={`inbox-contact-avatar tone-${tone}${props.size ? ` ${props.size}` : ""}${props.outgoing ? " outgoing" : ""}`}
      aria-hidden="true"
    >
      {props.multiple ? <Users size={props.size ? 11 : 15} /> : initials(props.label)}
      {props.provider ? (
        <span className={`inbox-avatar-provider ${props.provider}`}>
          <ProviderIcon provider={props.provider} />
        </span>
      ) : null}
    </span>
  );
}

function ProviderIcon(props: { provider: InboxProvider }): ReactNode {
  return props.provider === "outlook" ? <Mail size={15} /> : <MessageSquare size={15} />;
}

function DetailBlock(props: { label: string; children: ReactNode }): ReactNode {
  return (
    <section className="inbox-detail-block">
      <h3>{props.label}</h3>
      <div>{props.children}</div>
    </section>
  );
}

function matchesView(conversation: InboxConversationSummary, view: InboxView): boolean {
  if (view === "resolved") return conversation.status === "resolved";
  if (view === "waiting") return conversation.status === "waiting";
  if (view === "unread") return conversation.status !== "resolved" && conversation.unread;
  return conversation.status !== "resolved";
}

function conversationSorter(
  sort: InboxSort,
): (left: InboxConversationSummary, right: InboxConversationSummary) => number {
  if (sort === "oldest") return (left, right) => left.updatedAt.localeCompare(right.updatedAt);
  if (sort === "priority") {
    const rank: Record<InboxPriority, number> = { none: 0, low: 1, medium: 2, high: 3 };
    return (left, right) => rank[right.priority] - rank[left.priority] || right.updatedAt.localeCompare(left.updatedAt);
  }
  return (left, right) => right.updatedAt.localeCompare(left.updatedAt);
}

function nextSort(sort: InboxSort): InboxSort {
  if (sort === "newest") return "oldest";
  if (sort === "oldest") return "priority";
  return "newest";
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatTaskStatus(value: string): string {
  return value.replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase();
}

function formatTaskDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function formatRelativeTime(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed)) return "";
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  if (elapsed < 7 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)}d`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value));
}

function formatMessageTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function conversationAvatarLabel(conversation: InboxConversationSummary): string {
  if (conversation.participants.length > 1) return conversation.title;
  return conversation.participants[0]?.name || conversation.title;
}

function avatarTone(label: string): number {
  return [...label].reduce((total, character) => total + character.codePointAt(0)!, 0) % 5;
}

function providerLabel(service: string): string {
  if (service === "azure_devops") return "Azure DevOps";
  if (service === "microsoft_todo") return "Microsoft To Do";
  if (service === "microsoft_teams") return "Microsoft Teams";
  return service.split(/[_-]/gu).filter(Boolean).map(capitalize).join(" ");
}

function connectionLabel(connection: ConnectionRecord): string {
  const displayName = connection.profile?.displayName;
  if (typeof displayName === "string" && displayName.trim()) {
    return connection.connectionName && connection.connectionName !== "default"
      ? `${displayName} · ${connection.connectionName}`
      : displayName;
  }
  return connection.connectionName && connection.connectionName !== "default"
    ? connection.connectionName
    : providerLabel(connection.service);
}

function chooseHandoffConnection(
  connections: ConnectionRecord[],
  target: AiHandoffTarget,
  currentConnectionId: string,
): string {
  return (
    connections.find((connection) => connection.id === target.preferredConnectionId)?.id ??
    connections.find((connection) => connection.service === target.preferredService)?.id ??
    connections.find((connection) => connection.id === currentConnectionId)?.id ??
    connections[0]?.id ??
    ""
  );
}

function messagePreview(content: string): string {
  const compact = content.replace(/\s+/gu, " ").trim();
  return compact.length > 72 ? `${compact.slice(0, 69)}…` : compact || "Selected message";
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?"
  );
}

function messageForError(error: unknown, fallback: string): string {
  return error instanceof ApiError || error instanceof Error ? error.message : fallback;
}
