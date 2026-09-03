import type {
  InboxConversation,
  InboxConversationSummary,
  InboxLinkedTasks,
  InboxPage,
  InboxPriority,
  InboxProvider,
} from "./model";
import type { ChangeEvent, FormEvent, ReactNode } from "react";

import {
  AlertCircle,
  ArrowDownUp,
  ArrowDownLeft,
  ArrowUpRight,
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
  Search,
  Send,
  StickyNote,
  Tag,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Link } from "react-router";
import remarkGfm from "remark-gfm";
import { ApiError, apiGet, apiPost, apiPut, apiUpload } from "./api";
import { Button } from "@/components/ui/button";
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

export function InboxPageView(): ReactNode {
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
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [composerMode, setComposerMode] = useState<ComposerMode>("reply");
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [labelDraft, setLabelDraft] = useState("");
  const [linkedTasks, setLinkedTasks] = useState<InboxLinkedTasks>();
  const [loadingLinkedTasks, setLoadingLinkedTasks] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const messageList = useRef<HTMLDivElement>(null);

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
    void loadConversation(selectedId);
  }, [loadConversation, selectedId]);

  const lastMessageId = conversation?.messages.at(-1)?.id;
  useEffect(() => {
    const element = messageList.current;
    if (!element || !lastMessageId) return;
    const frame = window.requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [conversation?.id, lastMessageId]);

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
          attachments: attachments.map((file) => ({ fileId: file.fileId, name: file.name })),
        },
      );
      adoptConversation(next, selectedId);
      setReply("");
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

  const selectedSummary = page.conversations.find((item) => item.id === selectedId);
  const selectedSource = page.sources.find((source) => source.id === conversation?.sourceId);

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
              <div className={`inbox-avatar ${conversation.provider}`}>
                <ProviderIcon provider={conversation.provider} />
              </div>
              <div className="inbox-thread-heading">
                <strong>{conversation.title}</strong>
                <span>{conversation.contextLabel}</span>
              </div>
              <span className={`inbox-status ${conversation.status}`}>{conversation.status}</span>
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
                  <div className="inbox-message-meta">
                    {message.kind === "note" ? (
                      <StickyNote size={13} />
                    ) : message.direction === "inbound" ? (
                      <ArrowDownLeft size={13} />
                    ) : (
                      <ArrowUpRight size={13} />
                    )}
                    <strong>{message.sender.name}</strong>
                    <time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time>
                  </div>
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
                    setFiles([]);
                  }}
                >
                  Private note
                </button>
              </div>
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
                  <span>{initials(participant.name)}</span>
                  <span>
                    <strong>{participant.name}</strong>
                    {participant.email ? <small>{participant.email}</small> : null}
                  </span>
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
      <div className={`inbox-avatar ${item.provider}`}>
        <ProviderIcon provider={item.provider} />
      </div>
      <div className="inbox-list-copy">
        <div>
          <strong>{item.title}</strong>
          <time>{formatRelativeTime(item.updatedAt)}</time>
        </div>
        <span className="inbox-list-context">{item.contextLabel}</span>
        <p>{item.preview || "Attachment"}</p>
        {item.labels.length || item.priority !== "none" || item.status === "waiting" ? (
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
          </span>
        ) : null}
      </div>
      {item.unread ? <span className="inbox-unread" title="Unread" /> : null}
    </button>
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
