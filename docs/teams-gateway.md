# Microsoft Teams Gateway

The Teams gateway turns a connected, licensed Microsoft 365 user into a Teams agent backed by
Claude Code or OpenAI Codex. It handles 1:1 chats, group chats, and post threads in every visible
channel of the account's joined Teams. It runs inside OpenConnector: Paperclip, project mappings,
and a second credential store are not required.

## Setup

1. Configure the Microsoft Teams OAuth client, then connect each Microsoft 365 account that should
   act as an agent. Reconnect older Teams connections so they receive `User.ReadBasic.All`,
   `Chat.Read`, `Chat.Create`, `ChatMessage.Send`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`,
   `ChannelMessage.Read.All`, `ChannelMessage.Send`, `Files.ReadWrite.All`, and
   `Sites.ReadWrite.All`. The file scopes let the gateway read Teams attachments and upload replies
   through OneDrive or the channel's SharePoint folder. `Presence.ReadWrite` is requested for
   best-effort publishing of the identity's Teams availability, but the gateway does not depend on
   tenants allowing that optional write. The file scopes may require Microsoft 365 administrator
   consent, depending on tenant policy.
2. Connect a Claude or ChatGPT subscription on the **Agents** page.
3. Open **Teams gateway**, create an agent, and select its Teams identity and agent runtime.
4. Enter at least one internal email domain and choose the exact OpenConnector connections that the
   agent may use.
5. Save the agent. OpenConnector marks the gateway agent online, attempts to publish its Teams
   availability, and discovers its group chats, joined Teams, and visible channels.
6. Review **Detected groups** on the gateway page and disable any group chat or Team where the agent
   should not communicate. Disabled groups remain visible so they can be enabled later.

When `OOMOL_CONNECT_ORIGIN` is a public HTTPS origin, OpenConnector creates Microsoft Graph change
notification subscriptions for the agent's chats, joined-team channel lists, and visible channel
messages. Team and channel subscriptions are removed while that Team is disabled. The public
`/api/teams-gateway/webhook` endpoint validates each subscription's durable,
random `clientState` and wakes the normal cursor-based reader immediately. Subscriptions use a
55-minute lifetime and renew before expiry, staying below the duration that requires a separate
lifecycle notification URL.

The Node/Docker runtime continues to poll every 30 seconds as a fallback, so delayed notifications
or a temporary subscription failure do not stop message delivery. Set
`OOMOL_CONNECT_TEAMS_GATEWAY_POLL_MS` to change the fallback interval; the minimum is 10 seconds.

Each Teams connection can belong to only one gateway agent. Automatic continuous polling currently
runs in the Node runtime; the console's **Poll now** action is also available for diagnostics.
Presence publishing failures are retried every four minutes. If an older connection does not list
`Presence.ReadWrite`, reconnect it from the Microsoft Teams provider page. Teams can take a few
minutes to reflect a successful presence update. Existing connections must also be reconnected once
after upgrading to attachment support so the new file scopes are granted.

## Safety model

- Agents see only the exact connection-and-Action pairs captured when their configuration is saved.
- The standard Microsoft Teams chat-send Action is excluded from agent grants. Proactive DMs must
  use the gateway path so recipient policy cannot be bypassed.
- A recipient must be in an internal domain or be listed as an authorized external user.
- Separately, a recipient must have DMed that agent before or be on its proactive-DM whitelist.
- Only authorized inbound 1:1 DMs establish prior contact. Group chats do not unlock DMs.
- Group chat and channel senders still have to match an internal domain or the exact external-user
  allowlist.
- Disabled group chats and Teams are excluded from message reads, replies, pending-plan resumes, and
  pending-approval resumes. Direct 1:1 chats are unaffected.
- Messages sent by any enabled gateway identity are suppressed before agent dispatch. The runtime
  also tracks its own recently emitted message IDs so Graph sender inconsistencies cannot create an
  echo loop.
- App, system, and anonymous messages without a resolvable user identity are ignored.
- Provider actions still use OpenConnector's exact-request approval process and audit trail.
- Incoming files are capped by OpenConnector's transit-file limit (25 MB by default), staged only for
  the current agent turn, and explicitly treated as untrusted data.

## Conversations, plans, and approvals

Threads are durable, isolated per Teams agent and conversation, and processed with bounded
concurrency. Group rosters and channel/post names are supplied as conversation context. Channel
responses are posted as replies to the root post rather than as new channel posts. The configured
thread window controls when idle conversation context expires. Re-enabling a group starts from that
moment, so messages sent while it was disabled are not handled retroactively.

Because delegated Teams identities cannot publish a native typing indicator, the gateway immediately
sends a short acknowledgement when it accepts a message and when a thumbs-up releases a pending plan.
These transient notices are not added to the agent's conversation context.

Agent Markdown is converted to Teams-safe HTML before sending. Paragraphs, headings, bold and
italic text, links, code, quotes, lists, task lists, and tables retain their structure in chats and
channel replies; raw HTML and unsafe links are not passed through.

The proactive-DM list in agent setup also acts as the named escalation-recipient list. The agent can
combine it with people who have previously DMed that identity to resolve an exact recipient email,
then calls the host-owned `send_teams_dm` tool. Gateway host tools are constrained to the exact names
available for the current turn and remain separate from connector action discovery.

Agents can inspect reference attachments and inline images received from Teams. Files returned to a
channel are uploaded into that channel's SharePoint-backed **Files** folder and attached to the
current post thread. Files returned to a 1:1 or group chat are uploaded into the agent identity's
`OpenConnector` OneDrive folder and sent to the same chat as an organization-scoped sharing link.

When plan confirmation is enabled, the agent can answer without tools immediately, but it must
propose a plan before reading or changing a connected provider. React 👍 to the plan message to
confirm it, reply with a correction to receive an updated plan, or reply `cancel` to stop. Connector
approvals can be resolved in Teams with `approve`, `reject`, `approve CODE`,
`reject CODE`, `approve all`, or `reject all`. A multi-action batch remains paused until every item
is resolved.

Gateway agent configuration, contacts, discovered groups/channels, cursors, conversations, pending
plans, pending approval links, and Graph subscription secrets are stored in the runtime database and
pass through the configured secret codec.
