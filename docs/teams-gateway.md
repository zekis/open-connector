# Microsoft Teams Gateway

The Teams gateway turns a connected, licensed Microsoft 365 user into a Teams agent backed by
Claude Code or OpenAI Codex. It handles 1:1 chats, group chats, and post threads in every visible
channel of the account's joined Teams. It runs inside OpenConnector: Paperclip, project mappings,
and a second credential store are not required.

## Setup

1. Configure the Microsoft Teams OAuth client, then connect each Microsoft 365 account that should
   act as an agent. Reconnect older Teams connections so they receive `User.ReadBasic.All`,
   `Chat.Read`, `Chat.Create`, `ChatMessage.Send`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`,
   `ChannelMessage.Read.All`, and `ChannelMessage.Send`. `Presence.ReadWrite` is requested for
   best-effort publishing of the identity's Teams availability, but the gateway does not depend on
   tenants allowing that optional write.
2. Connect a Claude or ChatGPT subscription on the **Agents** page.
3. Open **Teams gateway**, create an agent, and select its Teams identity and agent runtime.
4. Enter at least one internal email domain and choose the exact OpenConnector connections that the
   agent may use.
5. Save the agent. OpenConnector marks the gateway agent online, attempts to publish its Teams
   availability, and discovers its group chats, joined Teams, and visible channels. The Node/Docker runtime polls every 30 seconds by default. Set
   `OOMOL_CONNECT_TEAMS_GATEWAY_POLL_MS` to change the interval; the minimum is 10 seconds.

Each Teams connection can belong to only one gateway agent. Automatic continuous polling currently
runs in the Node runtime; the console's **Poll now** action is also available for diagnostics.

## Safety model

- Agents see only the exact connection-and-Action pairs captured when their configuration is saved.
- The standard Microsoft Teams chat-send Action is excluded from agent grants. Proactive DMs must
  use the gateway path so recipient policy cannot be bypassed.
- A recipient must be in an internal domain or be listed as an authorized external user.
- Separately, a recipient must have DMed that agent before or be on its proactive-DM whitelist.
- Only authorized inbound 1:1 DMs establish prior contact. Group chats do not unlock DMs.
- Group chat and channel senders still have to match an internal domain or the exact external-user
  allowlist.
- Provider actions still use OpenConnector's exact-request approval process and audit trail.

## Conversations, plans, and approvals

Threads are durable, isolated per Teams agent and conversation, and processed with bounded
concurrency. Group rosters and channel/post names are supplied as conversation context. Channel
responses are posted as replies to the root post rather than as new channel posts. The configured
thread window controls when idle conversation context expires.

When plan confirmation is enabled, the agent can answer without tools immediately, but it must
propose a plan before reading or changing a connected provider. Reply `proceed`, `cancel`, or send a
correction. Connector approvals can be resolved in Teams with `approve`, `reject`, `approve CODE`,
`reject CODE`, `approve all`, or `reject all`. A multi-action batch remains paused until every item
is resolved.

Gateway agent configuration, contacts, discovered groups/channels, cursors, conversations, pending
plans, and pending approval links are stored in the runtime database and pass through the configured
secret codec.
