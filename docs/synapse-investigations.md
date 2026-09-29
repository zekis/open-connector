# Synapse investigations

Create a Synapse canvas with a question, such as “Research house prices in Perth, comparing recent sales and suburb trends.” New question canvases start with **Investigate linked cards** enabled. On an existing task or evidence card, enable the same option before sending an instruction.

One agent owns the original question throughout the investigation. Creating cards feeds their contents back into that same conversation. The agent can select a card with `synapse_focus_card`, read its evidence, choose retrieval tools, and create linked findings. It can revisit cards with different questions or compare evidence across cards before giving one final synthesis in the original conversation. Cards never start their own conversations, and no follow-ups run after the agent finishes. Cards and focus progress stream into the canvas. For tasks, try “Find related emails and documents, explain blockers, and identify the next action.”

Investigations have fixed server-side limits:

- Two follow-up levels and five card focus changes.
- Twelve new nodes, including provider cards.
- Twenty-four connector retrieval attempts, forty-eight tool steps for the whole investigation, and a ten-minute timeout.

**Stop** cancels remaining work and preserves saved cards. Canvas edits are blocked while work is running. A disconnected request stops its investigation; interrupted investigations retain their saved cards but do not automatically resume.

Investigation mode exposes retrieval-named connector actions and disables flow tools. Generic query/execution actions and mutation-named actions are excluded. Existing connector permissions and approvals still apply. It gathers task context; it does not execute tasks. Source availability depends on the connected providers, and missing evidence should be reported rather than invented.

Turn off **Investigate linked cards** for a normal single conversation. Investigation state uses the existing workspace JSON storage, so existing installations need no separate SQL migration.
