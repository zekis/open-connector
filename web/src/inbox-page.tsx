import type { InboxConversation, InboxConversationSummary, InboxPage, InboxProvider } from "./model";
import type { ChangeEvent, FormEvent, ReactNode } from "react";

import {
  AlertCircle,
  ArrowDownLeft,
  ArrowUpRight,
  FileText,
  Loader2,
  Mail,
  MessageSquare,
  Paperclip,
  RefreshCw,
  Search,
  Send,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Link } from "react-router";
import remarkGfm from "remark-gfm";
import { ApiError, apiGet, apiPost, apiUpload } from "./api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface TransitUpload {
  fileId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export function InboxPageView(): ReactNode {
  const [page, setPage] = useState<InboxPage>({ sources: [], conversations: [], errors: [] });
  const [selectedId, setSelectedId] = useState<string>();
  const [conversation, setConversation] = useState<InboxConversation>();
  const [sourceId, setSourceId] = useState("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [error, setError] = useState<string>();
  const [reply, setReply] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

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

  const visibleConversations = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return page.conversations.filter((item) => {
      if (sourceId !== "all" && item.sourceId !== sourceId && item.provider !== sourceId) return false;
      if (!normalizedQuery) return true;
      return [
        item.title,
        item.preview,
        item.contextLabel,
        ...item.participants.flatMap((person) => [person.name, person.email]),
      ]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(normalizedQuery));
    });
  }, [page.conversations, query, sourceId]);

  async function sendReply(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!selectedId || (!reply.trim() && files.length === 0) || sending) return;
    setSending(true);
    try {
      const attachments: TransitUpload[] = [];
      for (const file of files) attachments.push(await apiUpload<TransitUpload>("/api/files", file));
      const next = await apiPost<InboxConversation>(
        `/api/inbox/conversations/${encodeURIComponent(selectedId)}/replies`,
        {
          text: reply.trim(),
          attachments: attachments.map((file) => ({ fileId: file.fileId, name: file.name })),
        },
      );
      setConversation(next);
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

  function addFiles(event: ChangeEvent<HTMLInputElement>): void {
    const selected = [...(event.target.files ?? [])];
    setFiles((current) => [...current, ...selected].slice(0, 10));
    event.target.value = "";
  }

  const selectedSummary = page.conversations.find((item) => item.id === selectedId);
  const selectedSource = page.sources.find((source) => source.id === conversation?.sourceId);

  return (
    <section className="unified-inbox" aria-label="Unified inbox">
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
        </div>
        {page.errors.map((sourceError) => (
          <div className="inbox-source-error" key={sourceError.sourceId}>
            <AlertCircle size={14} />
            <span>{sourceError.message}</span>
          </div>
        ))}
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
              <div>
                <strong>{conversation.title}</strong>
                <span>{conversation.contextLabel}</span>
              </div>
              <span className={`inbox-status ${conversation.status}`}>{conversation.status}</span>
            </header>
            <div className="inbox-messages" aria-live="polite">
              {loadingConversation ? (
                <div className="inbox-loading">
                  <Loader2 className="spin" size={18} /> Loading conversation…
                </div>
              ) : null}
              {conversation.messages.map((message) => (
                <article className={`inbox-message ${message.direction}`} key={message.id}>
                  <div className="inbox-message-meta">
                    {message.direction === "inbound" ? <ArrowDownLeft size={13} /> : <ArrowUpRight size={13} />}
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
            <form className="inbox-composer" onSubmit={(event) => void sendReply(event)}>
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
                placeholder={`Reply via ${conversation.provider === "outlook" ? "Outlook" : "Teams"}…`}
                rows={3}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <div className="inbox-composer-actions">
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
                <span>Enter to send · Shift + Enter for a new line</span>
                <Button type="submit" size="sm" disabled={sending || (!reply.trim() && files.length === 0)}>
                  {sending ? <Loader2 className="spin" size={15} /> : <Send size={15} />}
                  Send
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
            <DetailBlock label="Activity">
              <span>{conversation.messageCount} recent messages</span>
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
        {item.status === "waiting" ? <small className="inbox-waiting">Waiting for approval</small> : null}
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
