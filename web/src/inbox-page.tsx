import type {
  ConnectionRecord,
  InboxAiActionScope,
  InboxConversation,
  InboxConversationSummary,
  InboxLinkedTasks,
  InboxMessage,
  InboxPage,
  InboxParticipant,
  InboxPriority,
  InboxProvider,
  ProviderDefinition,
  SynapseWorkspace,
} from "./model";
import type { ChangeEvent, CSSProperties, FormEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";

import {
  AlertCircle,
  ArrowLeft,
  ArrowDownUp,
  Ban,
  Bot,
  BrainCircuit,
  Cable,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ExternalLink,
  FileText,
  Loader2,
  ListTodo,
  Mail,
  MessageSquare,
  Paperclip,
  PanelRightClose,
  PanelRightOpen,
  Pin,
  RefreshCw,
  Reply as ReplyIcon,
  Search,
  Send,
  Forward as ForwardIcon,
  Sparkles,
  StickyNote,
  Tag,
  ThumbsUp,
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
type InboxMobilePane = "list" | "thread";
type InboxPanel = keyof InboxPanelWidths;

interface InboxPanelWidths {
  sources: number;
  conversations: number;
  details: number;
}

interface InboxResizeState {
  panel: InboxPanel;
  pointerId: number;
  startX: number;
  startWidth: number;
}

interface InboxContactFilter {
  id: string;
  key: string;
  provider: InboxProvider;
}

interface InboxChannelContact extends InboxContactFilter {
  name: string;
  email?: string;
  conversationCount: number;
  unreadCount: number;
  pinned: boolean;
  junk: boolean;
}

interface InboxChannelExpansion {
  microsoft_teams: boolean;
  outlook: boolean;
}

interface InboxChannelContactGroup {
  label: "Pinned" | "Unread" | "A–Z" | "Junk";
  contacts: InboxChannelContact[];
}

const defaultInboxPanelWidths: InboxPanelWidths = {
  sources: 224,
  conversations: 340,
  details: 260,
};
const inboxPanelWidthsStorageKey = "oomol.inbox.panel-widths";
const inboxPinnedContactsStorageKey = "oomol.inbox.pinned-contacts";
const inboxJunkContactsStorageKey = "oomol.inbox.junk-contacts";

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
  const [contactFilter, setContactFilter] = useState<InboxContactFilter>();
  const [pinnedContactIds, setPinnedContactIds] = useState<Set<string>>(readPinnedContactIds);
  const [junkContactIds, setJunkContactIds] = useState<Set<string>>(readJunkContactIds);
  const [junkGroupExpanded, setJunkGroupExpanded] = useState(false);
  const [expandedChannels, setExpandedChannels] = useState<InboxChannelExpansion>({
    microsoft_teams: true,
    outlook: true,
  });
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
  const [mobilePane, setMobilePane] = useState<InboxMobilePane>("list");
  const [panelWidths, setPanelWidths] = useState<InboxPanelWidths>(readInboxPanelWidths);
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
  const [approvingPlanMessageId, setApprovingPlanMessageId] = useState<string>();
  const [expandedEmailMessageIds, setExpandedEmailMessageIds] = useState<Set<string>>(new Set());
  const fileInput = useRef<HTMLInputElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const messageList = useRef<HTMLDivElement>(null);
  const lastMessageElement = useRef<HTMLElement>(null);
  const resizeState = useRef<InboxResizeState | undefined>(undefined);
  const contactFilterRef = useRef<InboxContactFilter | undefined>(undefined);
  const providersByService = useMemo(
    () => new Map(props.providers.map((provider) => [provider.service, provider])),
    [props.providers],
  );

  const loadPage = useCallback(
    async (silent = false): Promise<void> => {
      if (!silent) setLoading(true);
      try {
        const next = await apiGet<InboxPage>("/api/inbox");
        setPage(next);
        setSelectedId((current) => {
          const visible = next.conversations.filter((item) => !isJunkConversation(item, junkContactIds));
          const selectedJunkContact =
            contactFilterRef.current && junkContactIds.has(contactFilterRef.current.id)
              ? contactFilterRef.current
              : undefined;
          const canKeepCurrent = next.conversations.some(
            (item) =>
              item.id === current &&
              (visible.includes(item) ||
                (selectedJunkContact &&
                  item.provider === selectedJunkContact.provider &&
                  conversationHasContact(item, selectedJunkContact.key))),
          );
          return current && canKeepCurrent ? current : visible[0]?.id;
        });
        setError(undefined);
      } catch (loadError) {
        setError(messageForError(loadError, "Could not load the inbox."));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [junkContactIds],
  );

  const loadConversation = useCallback(async (id: string, silent = false): Promise<void> => {
    if (!silent) setLoadingConversation(true);
    try {
      const next = await apiGet<InboxConversation>(`/api/inbox/conversations/${encodeURIComponent(id)}`);
      setConversation(next);
      setError(undefined);
      if (next.unread) {
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
    contactFilterRef.current = contactFilter;
  }, [contactFilter]);

  useEffect(() => {
    void loadPage();
    const timer = window.setInterval(() => void loadPage(true), 30_000);
    return () => window.clearInterval(timer);
  }, [loadPage]);

  useEffect(() => {
    window.localStorage.setItem(inboxPanelWidthsStorageKey, JSON.stringify(panelWidths));
  }, [panelWidths]);

  useEffect(() => {
    window.localStorage.setItem(inboxPinnedContactsStorageKey, JSON.stringify([...pinnedContactIds]));
  }, [pinnedContactIds]);

  useEffect(() => {
    window.localStorage.setItem(inboxJunkContactsStorageKey, JSON.stringify([...junkContactIds]));
  }, [junkContactIds]);

  useEffect(
    () => () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    },
    [],
  );

  useEffect(() => {
    if (!selectedId) {
      setConversation(undefined);
      return;
    }
    setReplyingTo(undefined);
    setExpandedEmailMessageIds(new Set());
    void loadConversation(selectedId);
  }, [loadConversation, selectedId]);

  const lastMessage = conversation?.messages.at(-1);
  const lastMessageSignature = lastMessage
    ? `${lastMessage.id}:${lastMessage.createdAt}:${lastMessage.action?.status ?? ""}:${lastMessage.content}`
    : undefined;
  useEffect(() => {
    const element = messageList.current;
    const target = lastMessageElement.current;
    if (!element || !target || !lastMessageSignature) return;
    const frame = window.requestAnimationFrame(() => {
      const elementTop = element.getBoundingClientRect().top;
      const targetTop = target.getBoundingClientRect().top;
      element.scrollTop += targetTop - elementTop;
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

  const channelContacts = useMemo(
    () => ({
      microsoft_teams: buildChannelContacts(page.conversations, "microsoft_teams", pinnedContactIds, junkContactIds),
      outlook: buildChannelContacts(page.conversations, "outlook", pinnedContactIds, junkContactIds),
    }),
    [junkContactIds, page.conversations, pinnedContactIds],
  );
  const nonJunkConversations = useMemo(
    () => page.conversations.filter((item) => !isJunkConversation(item, junkContactIds)),
    [junkContactIds, page.conversations],
  );
  const selectedChannelContact = contactFilter
    ? [...channelContacts.microsoft_teams, ...channelContacts.outlook].find((item) => item.id === contactFilter.id)
    : undefined;

  const sourceConversations = useMemo(() => {
    const includeJunk = Boolean(contactFilter && junkContactIds.has(contactFilter.id));
    const inSource = page.conversations.filter(
      (item) => sourceId === "all" || item.sourceId === sourceId || item.provider === sourceId,
    );
    const visibleSource = includeJunk ? inSource : inSource.filter((item) => !isJunkConversation(item, junkContactIds));
    return contactFilter
      ? visibleSource.filter(
          (item) => item.provider === contactFilter.provider && conversationHasContact(item, contactFilter.key),
        )
      : visibleSource;
  }, [contactFilter, junkContactIds, page.conversations, sourceId]);

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

  function openConversation(id: string): void {
    setSelectedId(id);
    setMobilePane("thread");
  }

  async function approveTeamsPlan(messageId: string): Promise<void> {
    if (!selectedId || approvingPlanMessageId) return;
    setApprovingPlanMessageId(messageId);
    try {
      const next = await apiPost<InboxConversation>(
        `/api/inbox/conversations/${encodeURIComponent(selectedId)}/teams-plan-approval`,
        { messageId },
      );
      adoptConversation(next, selectedId);
      await loadPage(true);
    } catch (approvalError) {
      setError(messageForError(approvalError, "Could not approve this Teams plan."));
    } finally {
      setApprovingPlanMessageId(undefined);
    }
  }

  function selectSource(id: string): void {
    setSourceId(id);
    setContactFilter(undefined);
  }

  function selectContact(contact: InboxChannelContact): void {
    setSourceId(contact.provider);
    setContactFilter({ id: contact.id, key: contact.key, provider: contact.provider });
  }

  function toggleContactPin(id: string): void {
    setPinnedContactIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleJunkContact(id: string): void {
    const movingToJunk = !junkContactIds.has(id);
    setJunkContactIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (!movingToJunk) return;
    setPinnedContactIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    const nextJunkContactIds = new Set(junkContactIds);
    nextJunkContactIds.add(id);
    setSelectedId((current) => {
      if (!current) return current;
      const selected = page.conversations.find((item) => item.id === current);
      return selected && isJunkConversation(selected, nextJunkContactIds) ? undefined : current;
    });
    setContactFilter((current) => (current?.id === id ? undefined : current));
  }

  function toggleChannel(provider: InboxProvider): void {
    setExpandedChannels((current) => ({ ...current, [provider]: !current[provider] }));
  }

  function selectMobileSource(value: string): void {
    if (value === "junk-toggle") {
      setJunkGroupExpanded((current) => !current);
      return;
    }
    if (!value.startsWith("contact:")) {
      selectSource(value);
      return;
    }
    const id = value.slice("contact:".length);
    const contact = [...channelContacts.microsoft_teams, ...channelContacts.outlook].find((item) => item.id === id);
    if (contact) selectContact(contact);
  }

  function beginPanelResize(panel: InboxPanel, event: ReactPointerEvent<HTMLButtonElement>): void {
    event.preventDefault();
    resizeState.current = {
      panel,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: panelWidths[panel],
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  function continuePanelResize(event: ReactPointerEvent<HTMLButtonElement>): void {
    const active = resizeState.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const movement = event.clientX - active.startX;
    setPanelWidths((current) => ({
      ...current,
      [active.panel]: clampInboxPanelWidth(
        active.panel,
        active.startWidth + (active.panel === "details" ? -movement : movement),
        current,
      ),
    }));
  }

  function endPanelResize(event: ReactPointerEvent<HTMLButtonElement>): void {
    if (resizeState.current?.pointerId !== event.pointerId) return;
    resizeState.current = undefined;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }

  function resizePanelWithKeyboard(panel: InboxPanel, key: string): void {
    if (key !== "ArrowLeft" && key !== "ArrowRight") return;
    const movement = key === "ArrowRight" ? 12 : -12;
    setPanelWidths((current) => ({
      ...current,
      [panel]: clampInboxPanelWidth(panel, current[panel] + (panel === "details" ? -movement : movement), current),
    }));
  }

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

  function toggleEmailMessage(messageId: string): void {
    setExpandedEmailMessageIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
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

  const inboxStyle = {
    "--inbox-source-width": `${panelWidths.sources}px`,
    "--inbox-conversation-width": `${panelWidths.conversations}px`,
    "--inbox-detail-width": `${panelWidths.details}px`,
  } as CSSProperties;

  return (
    <section
      className={`unified-inbox${detailsOpen ? "" : " details-collapsed"} mobile-${mobilePane}-open`}
      style={inboxStyle}
      aria-label="Unified inbox"
    >
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
          count={nonJunkConversations.length}
          icon={<Users size={15} />}
          onClick={() => selectSource("all")}
        />
        <div className="inbox-source-heading">Channels</div>
        <ChannelTree
          provider="microsoft_teams"
          label="Microsoft Teams"
          count={nonJunkConversations.filter((item) => item.provider === "microsoft_teams").length}
          unreadCount={page.conversations.filter((item) => item.provider === "microsoft_teams" && item.unread).length}
          icon={<MessageSquare size={15} />}
          contacts={channelContacts.microsoft_teams}
          expanded={expandedChannels.microsoft_teams}
          active={sourceId === "microsoft_teams" && !contactFilter}
          activeContactId={contactFilter?.provider === "microsoft_teams" ? contactFilter.id : undefined}
          onToggle={() => toggleChannel("microsoft_teams")}
          onSelect={() => selectSource("microsoft_teams")}
          onSelectContact={selectContact}
          onTogglePin={toggleContactPin}
        />
        <ChannelTree
          provider="outlook"
          label="Outlook"
          count={nonJunkConversations.filter((item) => item.provider === "outlook").length}
          unreadCount={nonJunkConversations.filter((item) => item.provider === "outlook" && item.unread).length}
          icon={<Mail size={15} />}
          contacts={channelContacts.outlook}
          expanded={expandedChannels.outlook}
          junkExpanded={junkGroupExpanded}
          active={sourceId === "outlook" && !contactFilter}
          activeContactId={contactFilter?.provider === "outlook" ? contactFilter.id : undefined}
          onToggle={() => toggleChannel("outlook")}
          onSelect={() => selectSource("outlook")}
          onSelectContact={selectContact}
          onTogglePin={toggleContactPin}
          onToggleJunk={toggleJunkContact}
          onToggleJunkGroup={() => setJunkGroupExpanded((current) => !current)}
        />
        {page.sources.length ? <div className="inbox-source-heading">Accounts</div> : null}
        {page.sources.map((source) => (
          <SourceButton
            key={source.id}
            active={sourceId === source.id}
            label={source.displayName}
            detail={source.accountLabel}
            count={nonJunkConversations.filter((item) => item.sourceId === source.id).length}
            icon={<ProviderIcon provider={source.provider} />}
            disabled={!source.enabled}
            onClick={() => selectSource(source.id)}
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

      <button
        type="button"
        className="inbox-resize-handle sources"
        aria-label="Resize inbox sources panel"
        title="Drag to resize · Double-click to reset"
        onPointerDown={(event) => beginPanelResize("sources", event)}
        onPointerMove={continuePanelResize}
        onPointerUp={endPanelResize}
        onPointerCancel={endPanelResize}
        onDoubleClick={() => setPanelWidths((current) => ({ ...current, sources: defaultInboxPanelWidths.sources }))}
        onKeyDown={(event) => resizePanelWithKeyboard("sources", event.key)}
      />

      <aside className="inbox-conversations">
        <div className="inbox-mobile-bar">
          <div>
            <strong>Inbox</strong>
            <small>Teams + Outlook</small>
          </div>
          <label>
            <span>Source</span>
            <select
              value={contactFilter ? `contact:${contactFilter.id}` : sourceId}
              onChange={(event) => selectMobileSource(event.target.value)}
            >
              <option value="all">All accounts</option>
              <option value="microsoft_teams">Microsoft Teams</option>
              <option value="outlook">Outlook</option>
              {page.sources.map((source) => (
                <option key={source.id} value={source.id} disabled={!source.enabled}>
                  {source.displayName}
                </option>
              ))}
              {channelContacts.microsoft_teams.length ? (
                <optgroup label="Teams people">
                  {channelContacts.microsoft_teams.map((contact) => (
                    <option key={contact.id} value={`contact:${contact.id}`}>
                      {contact.pinned ? "Pinned · " : contact.unreadCount ? "Unread · " : ""}
                      {contact.name}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {channelContacts.outlook.some((contact) => !contact.junk) ? (
                <optgroup label="Outlook people">
                  {channelContacts.outlook
                    .filter((contact) => !contact.junk)
                    .map((contact) => (
                      <option key={contact.id} value={`contact:${contact.id}`}>
                        {contact.pinned ? "Pinned · " : contact.unreadCount ? "Unread · " : ""}
                        {contact.name}
                      </option>
                    ))}
                </optgroup>
              ) : null}
              {channelContacts.outlook.some((contact) => contact.junk) ? (
                <option value="junk-toggle">
                  {junkGroupExpanded ? "Hide" : "Show"} Junk (
                  {channelContacts.outlook.filter((contact) => contact.junk).length})
                </option>
              ) : null}
              {junkGroupExpanded ? (
                <optgroup label="Outlook junk">
                  {channelContacts.outlook
                    .filter((contact) => contact.junk)
                    .map((contact) => (
                      <option key={contact.id} value={`contact:${contact.id}`}>
                        Junk · {contact.name}
                      </option>
                    ))}
                </optgroup>
              ) : null}
            </select>
          </label>
          <div className="inbox-mobile-actions">
            {selectedChannelContact && !selectedChannelContact.junk ? (
              <Button
                className={`inbox-mobile-pin${selectedChannelContact.pinned ? " pinned" : ""}`}
                variant="ghost"
                size="icon-sm"
                onClick={() => toggleContactPin(selectedChannelContact.id)}
                aria-label={`${selectedChannelContact.pinned ? "Unpin" : "Pin"} ${selectedChannelContact.name}`}
              >
                <Pin size={14} />
              </Button>
            ) : null}
            {selectedChannelContact?.provider === "outlook" ? (
              <Button
                className={`inbox-mobile-junk${selectedChannelContact.junk ? " junk" : ""}`}
                variant="ghost"
                size="icon-sm"
                onClick={() => toggleJunkContact(selectedChannelContact.id)}
                aria-label={`${selectedChannelContact.junk ? "Restore" : "Move"} ${selectedChannelContact.name} ${selectedChannelContact.junk ? "from" : "to"} junk`}
              >
                <Ban size={14} />
              </Button>
            ) : null}
            <Button variant="ghost" size="icon-sm" onClick={() => void loadPage()} aria-label="Refresh inbox">
              {loading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            </Button>
          </div>
        </div>
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
              onClick={() => openConversation(item.id)}
            />
          ))}
          {!loading && visibleConversations.length === 0 ? (
            <div className="inbox-list-empty">No conversations match this view.</div>
          ) : null}
        </div>
      </aside>

      <button
        type="button"
        className="inbox-resize-handle conversations"
        aria-label="Resize conversation list"
        title="Drag to resize · Double-click to reset"
        onPointerDown={(event) => beginPanelResize("conversations", event)}
        onPointerMove={continuePanelResize}
        onPointerUp={endPanelResize}
        onPointerCancel={endPanelResize}
        onDoubleClick={() =>
          setPanelWidths((current) => ({ ...current, conversations: defaultInboxPanelWidths.conversations }))
        }
        onKeyDown={(event) => resizePanelWithKeyboard("conversations", event.key)}
      />

      <main className={`inbox-thread${conversation?.provider === "outlook" ? " outlook" : ""}`}>
        {conversation ? (
          <>
            <header className="inbox-thread-header">
              <Button
                className="inbox-mobile-back"
                variant="ghost"
                size="icon-sm"
                onClick={() => setMobilePane("list")}
                aria-label="Back to conversations"
              >
                <ArrowLeft size={17} />
              </Button>
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
                className="inbox-header-action"
                variant="outline"
                size="sm"
                onClick={() => openAiHandoff({ scope: "conversation", label: conversation.title })}
              >
                <Sparkles size={14} />
                <span>Send to AI</span>
              </Button>
              <Button
                className="inbox-header-action"
                variant={conversation.status === "resolved" ? "outline" : "default"}
                size="sm"
                onClick={() =>
                  void updateConversation({ status: conversation.status === "resolved" ? "open" : "resolved" })
                }
              >
                <CheckCircle2 size={14} />
                <span>{conversation.status === "resolved" ? "Reopen" : "Resolve"}</span>
              </Button>
              <Button
                className="inbox-details-toggle"
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
              {conversation.messages.map((message, index) => {
                const longEmail =
                  conversation.provider === "outlook" &&
                  message.kind === "message" &&
                  isLongEmailMessage(message.content);
                const expandedEmail = expandedEmailMessageIds.has(message.id);
                return (
                  <article
                    ref={index === conversation.messages.length - 1 ? lastMessageElement : undefined}
                    className={`inbox-message ${message.direction} ${message.kind}`}
                    key={message.id}
                  >
                    <div className="inbox-message-heading">
                      {message.kind === "message" ? (
                        <div className="inbox-message-toolbar" aria-label="Message actions">
                          {conversation.pendingPlanMessageId === message.id ? (
                            <button
                              type="button"
                              className="inbox-plan-approve"
                              disabled={Boolean(approvingPlanMessageId)}
                              onClick={() => void approveTeamsPlan(message.id)}
                              title="Approve this Teams plan"
                            >
                              {approvingPlanMessageId === message.id ? (
                                <Loader2 className="spin" size={12} />
                              ) : (
                                <ThumbsUp size={12} />
                              )}
                              Approve plan
                            </button>
                          ) : null}
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
                    <div className={`inbox-message-body${longEmail && !expandedEmail ? " collapsed" : ""}`}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                    </div>
                    {longEmail ? (
                      <button
                        type="button"
                        className="inbox-message-more"
                        onClick={() => toggleEmailMessage(message.id)}
                        aria-expanded={expandedEmail}
                      >
                        {expandedEmail ? "Show less" : "More"}
                        {expandedEmail ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                      </button>
                    ) : null}
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
                );
              })}
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

      <button
        type="button"
        className="inbox-resize-handle details"
        aria-label="Resize conversation details"
        title="Drag to resize · Double-click to reset"
        onPointerDown={(event) => beginPanelResize("details", event)}
        onPointerMove={continuePanelResize}
        onPointerUp={endPanelResize}
        onPointerCancel={endPanelResize}
        onDoubleClick={() => setPanelWidths((current) => ({ ...current, details: defaultInboxPanelWidths.details }))}
        onKeyDown={(event) => resizePanelWithKeyboard("details", event.key)}
      />

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

interface ChannelTreeProps {
  provider: InboxProvider;
  label: string;
  count: number;
  unreadCount: number;
  icon: ReactNode;
  contacts: InboxChannelContact[];
  expanded: boolean;
  active: boolean;
  activeContactId?: string;
  junkExpanded?: boolean;
  onToggle(): void;
  onSelect(): void;
  onSelectContact(contact: InboxChannelContact): void;
  onTogglePin(id: string): void;
  onToggleJunk?(id: string): void;
  onToggleJunkGroup?(): void;
}

function ChannelTree(props: ChannelTreeProps): ReactNode {
  const groups = channelContactGroups(props.contacts);
  return (
    <section className={`inbox-channel-tree ${props.provider}`}>
      <div className="inbox-channel-header">
        <button
          type="button"
          className="inbox-channel-toggle"
          onClick={props.onToggle}
          aria-expanded={props.expanded}
          aria-label={`${props.expanded ? "Collapse" : "Expand"} ${props.label} people`}
        >
          {props.expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <button
          type="button"
          className={`inbox-channel-select${props.active ? " active" : ""}`}
          onClick={props.onSelect}
        >
          <span className="inbox-source-icon">{props.icon}</span>
          <strong>{props.label}</strong>
          <span className="inbox-channel-counts">
            {props.unreadCount ? <small>{props.unreadCount} unread</small> : null}
            <span>{props.count}</span>
          </span>
        </button>
      </div>
      {props.expanded ? (
        <div className="inbox-channel-contacts" role="tree" aria-label={`${props.label} people`}>
          {groups.map((group) => (
            <div className="inbox-channel-contact-group" role="group" aria-label={group.label} key={group.label}>
              {group.label === "Junk" ? (
                <button
                  type="button"
                  className="inbox-channel-junk-group"
                  onClick={props.onToggleJunkGroup}
                  aria-expanded={props.junkExpanded}
                >
                  {props.junkExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                  <Ban size={11} />
                  <span>Junk</span>
                  <small>{group.contacts.length}</small>
                </button>
              ) : (
                <span className="inbox-channel-contact-group-title">{group.label}</span>
              )}
              {(group.label !== "Junk" || props.junkExpanded ? group.contacts : []).map((contact) => (
                <div
                  className={`inbox-channel-contact${contact.junk ? " junk" : ""}${props.activeContactId === contact.id ? " active" : ""}`}
                  role="treeitem"
                  aria-selected={props.activeContactId === contact.id}
                  key={contact.id}
                >
                  <button
                    type="button"
                    className="inbox-channel-contact-select"
                    onClick={() => props.onSelectContact(contact)}
                  >
                    <ContactAvatar label={contact.name} size="small" />
                    <span>
                      <strong>{contact.name}</strong>
                      {contact.email && contact.email.toLowerCase() !== contact.name.toLowerCase() ? (
                        <small>{contact.email}</small>
                      ) : null}
                    </span>
                    {contact.unreadCount ? (
                      <span className="inbox-channel-unread" title={`${contact.unreadCount} unread conversations`}>
                        {contact.unreadCount}
                      </span>
                    ) : contact.conversationCount > 1 ? (
                      <span className="inbox-channel-conversation-count">{contact.conversationCount}</span>
                    ) : null}
                  </button>
                  <span className="inbox-channel-contact-actions">
                    {!contact.junk ? (
                      <button
                        type="button"
                        className={`inbox-channel-pin${contact.pinned ? " pinned" : ""}`}
                        onClick={() => props.onTogglePin(contact.id)}
                        aria-label={`${contact.pinned ? "Unpin" : "Pin"} ${contact.name}`}
                        title={`${contact.pinned ? "Unpin" : "Pin"} ${contact.name}`}
                      >
                        <Pin size={11} />
                      </button>
                    ) : null}
                    {props.provider === "outlook" ? (
                      <button
                        type="button"
                        className={`inbox-channel-junk${contact.junk ? " junk" : ""}`}
                        onClick={() => props.onToggleJunk?.(contact.id)}
                        aria-label={`${contact.junk ? "Restore emails from" : "Hide emails from"} ${contact.name}`}
                        title={`${contact.junk ? "Restore emails from" : "Hide emails from"} ${contact.name}`}
                      >
                        <Ban size={11} />
                      </button>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          ))}
          {props.contacts.length === 0 ? <small className="inbox-channel-empty">No people yet</small> : null}
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

function readInboxPanelWidths(): InboxPanelWidths {
  try {
    const stored = JSON.parse(window.localStorage.getItem(inboxPanelWidthsStorageKey) ?? "null") as Record<
      string,
      unknown
    > | null;
    return {
      sources: storedPanelWidth(stored?.sources, "sources"),
      conversations: storedPanelWidth(stored?.conversations, "conversations"),
      details: storedPanelWidth(stored?.details, "details"),
    };
  } catch {
    return defaultInboxPanelWidths;
  }
}

function readPinnedContactIds(): Set<string> {
  try {
    const stored = JSON.parse(window.localStorage.getItem(inboxPinnedContactsStorageKey) ?? "[]") as unknown;
    return new Set(Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function readJunkContactIds(): Set<string> {
  try {
    const stored = JSON.parse(window.localStorage.getItem(inboxJunkContactsStorageKey) ?? "[]") as unknown;
    return new Set(Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function buildChannelContacts(
  conversations: InboxConversationSummary[],
  provider: InboxProvider,
  pinnedContactIds: Set<string>,
  junkContactIds: Set<string>,
): InboxChannelContact[] {
  const contacts = new Map<string, InboxChannelContact>();
  for (const conversation of conversations) {
    if (conversation.provider !== provider) continue;
    const participants = conversation.participants.length ? conversation.participants : [{ name: conversation.title }];
    const conversationContacts = new Set<string>();
    for (const participant of participants) {
      const key = inboxContactKey(participant);
      if (!key || conversationContacts.has(key)) continue;
      conversationContacts.add(key);
      const id = inboxContactId(provider, key);
      const existing = contacts.get(id);
      if (existing) {
        existing.conversationCount += 1;
        if (conversation.unread) existing.unreadCount += 1;
        continue;
      }
      contacts.set(id, {
        id,
        key,
        provider,
        name: participant.name.trim() || participant.email?.trim() || conversation.title,
        email: participant.email?.trim(),
        conversationCount: 1,
        unreadCount: conversation.unread ? 1 : 0,
        pinned: pinnedContactIds.has(id),
        junk: provider === "outlook" && junkContactIds.has(id),
      });
    }
  }
  return [...contacts.values()].sort((left, right) => {
    if (left.junk !== right.junk) return left.junk ? 1 : -1;
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    if (Boolean(left.unreadCount) !== Boolean(right.unreadCount)) return left.unreadCount ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
}

function channelContactGroups(contacts: InboxChannelContact[]): InboxChannelContactGroup[] {
  const groups: InboxChannelContactGroup[] = [
    { label: "Pinned", contacts: contacts.filter((contact) => contact.pinned && !contact.junk) },
    {
      label: "Unread",
      contacts: contacts.filter((contact) => !contact.pinned && !contact.junk && contact.unreadCount > 0),
    },
    {
      label: "A–Z",
      contacts: contacts.filter((contact) => !contact.pinned && !contact.junk && contact.unreadCount === 0),
    },
    { label: "Junk", contacts: contacts.filter((contact) => contact.junk) },
  ];
  return groups.filter((group) => group.contacts.length > 0);
}

function conversationHasContact(conversation: InboxConversationSummary, key: string): boolean {
  const participants = conversation.participants.length ? conversation.participants : [{ name: conversation.title }];
  return participants.some((participant) => inboxContactKey(participant) === key);
}

function isJunkConversation(conversation: InboxConversationSummary, junkContactIds: Set<string>): boolean {
  if (conversation.provider !== "outlook") return false;
  const participants = conversation.participants.length ? conversation.participants : [{ name: conversation.title }];
  return participants.some((participant) =>
    junkContactIds.has(inboxContactId("outlook", inboxContactKey(participant))),
  );
}

function inboxContactKey(participant: InboxParticipant): string {
  return (participant.email?.trim() || participant.name.trim()).toLowerCase();
}

function inboxContactId(provider: InboxProvider, key: string): string {
  return `${provider}:${encodeURIComponent(key)}`;
}

function storedPanelWidth(value: unknown, panel: InboxPanel): number {
  return typeof value === "number" && Number.isFinite(value)
    ? clampInboxPanelWidth(panel, value, defaultInboxPanelWidths, false)
    : defaultInboxPanelWidths[panel];
}

function clampInboxPanelWidth(
  panel: InboxPanel,
  value: number,
  widths: InboxPanelWidths,
  constrainToViewport = true,
): number {
  const minimums: InboxPanelWidths = { sources: 176, conversations: 280, details: 220 };
  const maximums: InboxPanelWidths = { sources: 340, conversations: 540, details: 440 };
  let maximum = maximums[panel];
  if (constrainToViewport) {
    const otherPanels = Object.entries(widths).reduce(
      (total, [name, width]) => total + (name === panel ? 0 : width),
      0,
    );
    maximum = Math.min(maximum, window.innerWidth - otherPanels - 380);
  }
  return Math.round(Math.max(minimums[panel], Math.min(Math.max(minimums[panel], maximum), value)));
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

function isLongEmailMessage(content: string): boolean {
  return content.length > 900 || content.split(/\r?\n/).length > 14;
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
