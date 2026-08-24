import type { AppData, FeedApprovalSummary, FeedItem, FeedPage, FeedPreview, ProviderDefinition } from "./model";
import type { FormEvent, ReactNode } from "react";

import {
  Bot,
  CalendarDays,
  Check,
  CheckCircle2,
  CircleAlert,
  Clock3,
  ExternalLink,
  File,
  FileImage,
  Files,
  FileText,
  Inbox,
  LineChart,
  Loader2,
  Mail,
  Maximize2,
  MessageCircle,
  MessageSquareText,
  Paperclip,
  Radio,
  Send,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  TriangleAlert,
  Users,
  Workflow,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "./api";
import { ChatMarkdown } from "./chat-markdown";
import { EmptyState, ProviderIcon } from "./shared-ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

const feedRefreshIntervalMs = 5_000;

export function FeedPageView(props: { data: AppData; onRefresh(): void }): ReactNode {
  const [page, setPage] = useState<FeedPage>({ items: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [approvalBusy, setApprovalBusy] = useState<string | undefined>(undefined);
  const [replyBusy, setReplyBusy] = useState<string | undefined>(undefined);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const providersByService = useMemo(
    () => new Map(props.data.providers.map((provider) => [provider.service, provider])),
    [props.data.providers],
  );

  const refresh = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setLoading(true);
    try {
      const next = await apiGet<FeedPage>("/api/feed");
      setPage(next);
      setError(null);
    } catch (caught) {
      if (!silent) setError(caught instanceof Error ? caught.message : "Could not load the activity Feed.");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), feedRefreshIntervalMs);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function decide(approval: FeedApprovalSummary, decision: "approve" | "deny"): Promise<void> {
    if (approvalBusy) return;
    setApprovalBusy(approval.id);
    setError(null);
    try {
      const collection = approval.kind === "flow" ? "flow-approvals" : "action-approvals";
      await apiPost(`/api/${collection}/${approval.id}/${decision}`, {});
      await refresh(true);
      props.onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The approval decision could not be recorded.");
    } finally {
      setApprovalBusy(undefined);
    }
  }

  async function reply(event: FormEvent, item: FeedItem): Promise<void> {
    event.preventDefault();
    const content = drafts[item.id]?.trim();
    if (!content || replyBusy) return;
    setReplyBusy(item.id);
    setError(null);
    try {
      const updated = await apiPost<FeedItem>(`/api/feed/${encodeURIComponent(item.id)}/comments`, { content });
      setPage((current) => ({
        items: current.items.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
      }));
      setDrafts((current) => ({ ...current, [item.id]: "" }));
      props.onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Claude could not reply to this Feed post.");
    } finally {
      setReplyBusy(undefined);
    }
  }

  return (
    <div className="feed-page">
      <header className="feed-intro">
        <span className="feed-intro-icon">
          <Radio size={19} aria-hidden="true" />
        </span>
        <div>
          <h2>Your connected world, caught up.</h2>
          <p>Review triggered activity, Claude's work, and decisions that need you.</p>
        </div>
        <Button variant="outline" size="icon-sm" onClick={() => void refresh()} aria-label="Refresh Feed">
          {loading ? <Loader2 className="spin" size={16} /> : <Radio size={16} />}
        </Button>
      </header>

      {error ? (
        <div className="feed-error" role="alert">
          <CircleAlert size={16} />
          {error}
        </div>
      ) : null}

      {!loading && page.items.length === 0 ? (
        <EmptyState
          icon={<Inbox size={22} />}
          title="Nothing in your Feed yet"
          description="Triggered Flow runs and pending approvals will appear here automatically."
        />
      ) : (
        <div className="feed-list" aria-live="polite">
          {page.items.map((item) => (
            <FeedCard
              key={item.id}
              item={item}
              provider={item.providerService ? providersByService.get(item.providerService) : undefined}
              draft={drafts[item.id] ?? ""}
              approvalBusy={approvalBusy}
              replyBusy={replyBusy === item.id}
              onDraftChange={(value) => setDrafts((current) => ({ ...current, [item.id]: value }))}
              onDecision={decide}
              onReply={reply}
            />
          ))}
          {loading ? (
            <div className="feed-loading">
              <Loader2 className="spin" size={17} /> Loading your Feed…
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function FeedCard(props: {
  item: FeedItem;
  provider?: ProviderDefinition;
  draft: string;
  approvalBusy?: string;
  replyBusy: boolean;
  onDraftChange(value: string): void;
  onDecision(approval: FeedApprovalSummary, decision: "approve" | "deny"): Promise<void>;
  onReply(event: FormEvent, item: FeedItem): Promise<void>;
}): ReactNode {
  const pendingApproval = props.item.approvals.some((approval) => approval.status === "pending");
  const [selectedPreview, setSelectedPreview] = useState<FeedPreview | undefined>(undefined);
  const displayName =
    props.item.flow?.name ?? props.item.author ?? props.provider?.displayName ?? triggerLabel(props.item);
  return (
    <article className={pendingApproval ? "feed-card needs-approval" : "feed-card"}>
      <div className="feed-post">
        <div className="feed-avatar provider">
          {props.provider ? <ProviderIcon provider={props.provider} large /> : <FileText size={21} />}
        </div>
        <div className="feed-post-body">
          <div className="feed-post-meta">
            <strong>{displayName}</strong>
            <span className="feed-handle">@claude</span>
            <span>·</span>
            <time dateTime={props.item.createdAt}>{relativeTime(props.item.createdAt)}</time>
            {props.item.flow ? (
              <span className={`feed-status ${props.item.flow.status}`}>{props.item.flow.status}</span>
            ) : null}
          </div>
          <FeedGeneratedImage post={props.item.post} />
          <div className="feed-social-copy">
            <ChatMarkdown>{props.item.post.text}</ChatMarkdown>
          </div>
          <div className="feed-origin">
            <Radio size={13} /> {triggerLabel(props.item)} · {props.item.title}
            {props.item.author && props.item.author !== displayName ? ` · ${props.item.author}` : ""}
          </div>
          {props.item.actions.length > 0 ? (
            <div className="feed-action-strip">
              {props.item.actions.slice(0, 5).map((action) => (
                <span key={action.id} className={`feed-action-chip ${action.status}`} title={action.actionId}>
                  {action.status === "completed" ? <Check size={12} /> : <Wrench size={12} />}
                  {humanizeAction(action.actionId)}
                </span>
              ))}
              {props.item.actions.length > 5 ? <span>+{props.item.actions.length - 5} more</span> : null}
            </div>
          ) : null}
        </div>
      </div>

      {props.item.previews.length > 0 ? (
        <FeedPreviewGallery previews={props.item.previews} onOpen={setSelectedPreview} />
      ) : null}

      {props.item.comments.map((comment) => (
        <div key={comment.id} className={`feed-comment ${comment.role}`}>
          <div className={`feed-avatar ${comment.role}`}>
            {comment.role === "assistant" ? <Bot size={16} /> : "You"}
          </div>
          <div className="feed-comment-body">
            <strong>{comment.role === "assistant" ? "Claude" : "You"}</strong>
            {comment.role === "assistant" ? <ChatMarkdown>{comment.content}</ChatMarkdown> : <p>{comment.content}</p>}
            {comment.toolActivity?.length ? (
              <small>
                {comment.toolActivity.length} connected action{comment.toolActivity.length === 1 ? "" : "s"}
              </small>
            ) : null}
          </div>
        </div>
      ))}

      {props.item.approvals.map((approval) => (
        <div className="feed-approval" key={approval.id}>
          <span className="feed-approval-icon">
            <Clock3 size={18} />
          </span>
          <div className="feed-approval-copy">
            <strong>Claude needs your approval</strong>
            <span>{humanizeAction(approval.actionId)}</span>
            <details>
              <summary>Review request</summary>
              <pre>{JSON.stringify(approval.input, null, 2)}</pre>
            </details>
          </div>
          <div className="feed-approval-actions">
            <Button
              size="icon"
              disabled={Boolean(props.approvalBusy)}
              aria-label={`Approve ${approval.actionId}`}
              title="Approve once"
              onClick={() => void props.onDecision(approval, "approve")}
            >
              {props.approvalBusy === approval.id ? <Loader2 className="spin" size={18} /> : <ThumbsUp size={18} />}
            </Button>
            <Button
              variant="outline"
              size="icon"
              disabled={Boolean(props.approvalBusy)}
              aria-label={`Deny ${approval.actionId}`}
              title="Deny"
              onClick={() => void props.onDecision(approval, "deny")}
            >
              <ThumbsDown size={18} />
            </Button>
          </div>
        </div>
      ))}

      {props.item.canReply ? (
        <form className="feed-composer" onSubmit={(event) => void props.onReply(event, props.item)}>
          <MessageCircle size={16} aria-hidden="true" />
          <Textarea
            rows={1}
            value={props.draft}
            disabled={pendingApproval || props.replyBusy}
            placeholder={pendingApproval ? "Decide the pending request to continue…" : "Reply to Claude about this…"}
            aria-label={`Reply to ${props.item.title}`}
            onChange={(event) => props.onDraftChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <Button
            size="icon-sm"
            disabled={!props.draft.trim() || pendingApproval || props.replyBusy}
            aria-label="Post reply"
          >
            {props.replyBusy ? <Loader2 className="spin" size={15} /> : <Send size={15} />}
          </Button>
        </form>
      ) : null}

      <FeedPreviewDialog preview={selectedPreview} onOpenChange={(open) => !open && setSelectedPreview(undefined)} />
    </article>
  );
}

function FeedGeneratedImage(props: { post: FeedItem["post"] }): ReactNode {
  return (
    <figure className={`feed-generated-image ${props.post.image.palette}`} role="img" aria-label={props.post.image.alt}>
      <span className="feed-generated-grid" aria-hidden="true" />
      <span className="feed-generated-orb one" aria-hidden="true" />
      <span className="feed-generated-orb two" aria-hidden="true" />
      <span className="feed-generated-icon" aria-hidden="true">
        <FeedMotifIcon motif={props.post.image.motif} />
      </span>
      <figcaption>
        <span>
          <Sparkles size={12} /> AI visual
        </span>
        <strong>{props.post.image.headline}</strong>
      </figcaption>
    </figure>
  );
}

function FeedMotifIcon(props: { motif: FeedItem["post"]["image"]["motif"] }): ReactNode {
  switch (props.motif) {
    case "calendar":
      return <CalendarDays />;
    case "chart":
      return <LineChart />;
    case "document":
      return <FileText />;
    case "files":
      return <Files />;
    case "message":
      return <MessageSquareText />;
    case "people":
      return <Users />;
    case "success":
      return <CheckCircle2 />;
    case "warning":
      return <TriangleAlert />;
    case "automation":
      return <Workflow />;
  }
}

function FeedPreviewGallery(props: { previews: FeedPreview[]; onOpen(preview: FeedPreview): void }): ReactNode {
  const email = props.previews.find((preview) => preview.kind === "email");
  const attachments = props.previews.filter((preview) => preview.kind !== "email");
  return (
    <section className="feed-previews" aria-label="Post previews">
      {email ? <FeedEmailPreview preview={email} onOpen={props.onOpen} /> : null}
      {attachments.length > 0 ? (
        <div className="feed-attachment-heading">
          <Paperclip size={13} /> {attachments.length} attachment{attachments.length === 1 ? "" : "s"}
        </div>
      ) : null}
      {attachments.length > 0 ? (
        <div className="feed-preview-grid">
          {attachments.map((preview) => (
            <FeedFilePreview key={preview.id} preview={preview} onOpen={props.onOpen} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function FeedEmailPreview(props: { preview: FeedPreview; onOpen(preview: FeedPreview): void }): ReactNode {
  const canOpen = Boolean(props.preview.contentUrl || props.preview.externalUrl);
  return (
    <div className="feed-email-preview">
      <span className="feed-preview-icon email">
        <Mail size={18} />
      </span>
      <div>
        <strong>Email</strong>
        <span>{props.preview.summary ?? "Open the complete message and its original formatting."}</span>
      </div>
      {canOpen ? (
        <Button variant="ghost" size="sm" onClick={() => props.onOpen(props.preview)}>
          <Maximize2 size={14} /> Open email
        </Button>
      ) : null}
    </div>
  );
}

function FeedFilePreview(props: { preview: FeedPreview; onOpen(preview: FeedPreview): void }): ReactNode {
  const canOpen = Boolean(props.preview.contentUrl || props.preview.externalUrl);
  const visual = props.preview.kind === "image" && props.preview.contentUrl;
  const pdf = props.preview.kind === "pdf" && props.preview.contentUrl;
  return (
    <div className={`feed-file-preview ${props.preview.kind}`}>
      {visual ? (
        <img src={props.preview.contentUrl} alt={props.preview.name} loading="lazy" />
      ) : pdf ? (
        <iframe
          src={`${props.preview.contentUrl}#page=1&toolbar=0&navpanes=0&scrollbar=0`}
          title={`Preview of ${props.preview.name}`}
          loading="lazy"
          tabIndex={-1}
        />
      ) : (
        <span className="feed-file-placeholder">
          <PreviewIcon preview={props.preview} />
        </span>
      )}
      <div className="feed-file-caption">
        <span className="feed-preview-icon">
          <PreviewIcon preview={props.preview} />
        </span>
        <div>
          <strong title={props.preview.name}>{props.preview.name}</strong>
          <span>{previewMeta(props.preview)}</span>
        </div>
        {canOpen ? (
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={`Open ${props.preview.name}`}
            onClick={() => props.onOpen(props.preview)}
          >
            <Maximize2 size={15} />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function FeedPreviewDialog(props: { preview: FeedPreview | undefined; onOpenChange(open: boolean): void }): ReactNode {
  const preview = props.preview;
  const embeddedUrl = preview ? previewContentUrl(preview) : undefined;
  return (
    <Dialog open={Boolean(preview)} onOpenChange={props.onOpenChange}>
      <DialogContent className="feed-preview-dialog sm:max-w-[min(1080px,calc(100vw-2rem))]">
        {preview ? (
          <>
            <DialogHeader>
              <DialogTitle>{preview.name}</DialogTitle>
              <DialogDescription>{previewMeta(preview)}</DialogDescription>
            </DialogHeader>
            <div className={`feed-preview-full ${preview.kind}`}>
              {preview.kind === "image" && embeddedUrl ? (
                <img src={embeddedUrl} alt={preview.name} />
              ) : embeddedUrl ? (
                <iframe src={embeddedUrl} title={preview.name} />
              ) : (
                <div className="feed-preview-unavailable">
                  <PreviewIcon preview={preview} />
                  <span>Use the connected application to open this item in full.</span>
                </div>
              )}
            </div>
            <div className="feed-preview-dialog-actions">
              {preview.contentUrl ? (
                <Button asChild variant="outline" size="sm">
                  <a href={preview.contentUrl} target="_blank" rel="noreferrer">
                    <ExternalLink size={14} /> Open raw file
                  </a>
                </Button>
              ) : null}
              {preview.externalUrl ? (
                <Button asChild size="sm">
                  <a href={preview.externalUrl} target="_blank" rel="noreferrer">
                    <ExternalLink size={14} /> Open in connected app
                  </a>
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PreviewIcon({ preview }: { preview: FeedPreview }): ReactNode {
  if (preview.kind === "email") return <Mail size={20} />;
  if (preview.kind === "image") return <FileImage size={20} />;
  if (preview.kind === "pdf" || preview.kind === "document") return <FileText size={20} />;
  return <File size={20} />;
}

function previewContentUrl(preview: FeedPreview): string | undefined {
  if (!preview.contentUrl) return undefined;
  if (preview.kind === "pdf") return `${preview.contentUrl}#view=FitH`;
  if (preview.kind === "document" && !isTextMimeType(preview.mimeType)) return undefined;
  if (preview.kind === "file") return undefined;
  return preview.contentUrl;
}

function isTextMimeType(mimeType: string | undefined): boolean {
  return mimeType?.startsWith("text/") === true;
}

function previewMeta(preview: FeedPreview): string {
  const type = preview.kind === "pdf" ? "PDF" : (preview.mimeType ?? humanizeAction(preview.kind));
  return preview.sizeBytes === undefined ? type : `${type} · ${formatBytes(preview.sizeBytes)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(bytes < 10 * 1_024 * 1_024 ? 1 : 0)} MB`;
}

function triggerLabel(item: FeedItem): string {
  const trigger = item.flow?.trigger;
  if (trigger === "new_email") return "New email";
  if (trigger === "file_created") return "New file";
  if (trigger === "schedule") return "Scheduled update";
  if (trigger === "api") return "API event";
  if (trigger === "event") return "Connector event";
  return "Activity";
}

function humanizeAction(actionId: string): string {
  const name = actionId.includes(".") ? actionId.slice(actionId.indexOf(".") + 1) : actionId;
  return name.replace(/[._-]+/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

function relativeTime(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return value;
  const seconds = Math.round((milliseconds - Date.now()) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}
