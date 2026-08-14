import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";
import { vaultGardenerCurationActions } from "./curation-actions.ts";

const service = "vaultgardener_memory";

const sessionIdSchema = s.nonEmptyString(
  "Stable, non-secret identifier reused across all memory calls in one conversation or task.",
  { maxLength: 160 },
);
const memoryIdSchema = s.positiveInteger("Numeric memory identifier returned by VaultGardener.");
const sourceFileSchema = s.nonEmptyString("Vault-relative source file returned by VaultGardener.", { maxLength: 500 });
const unitInterval = (description: string): JsonSchema => s.number(description, { minimum: 0, maximum: 1 });
const emotionalStateSchema = s.looseObject(
  {
    cues: s.stringArray("Context cues contributing to the emotional state."),
    urgency: unitInterval("Learned urgency signal."),
    risk: unitInterval("Learned risk signal."),
    positive_valence: unitInterval("Positive-valence signal."),
    negative_valence: unitInterval("Negative-valence signal."),
    unresolved: unitInterval("Unresolved-work signal."),
    confidence: unitInterval("Confidence in the aggregate emotional state."),
  },
  { description: "Learned emotional attention signals for the current context." },
);
const activationContributionSchema = s.looseObject(
  {
    kind: s.stringEnum("Activation contribution kind.", ["direct", "linguistic", "pathway", "associative", "recent"]),
    source: s.string("Source of the activation contribution."),
    amount: unitInterval("Activation contributed by this source."),
    depth: s.nonNegativeInteger("Association traversal depth."),
  },
  { description: "One contribution to a region's current activation." },
);
const activeRegionSchema = s.looseObject(
  {
    id: s.positiveInteger("Region identifier."),
    name: s.nonEmptyString("Learned memory-region name."),
    concept_type: s.string("Region concept type."),
    activation: unitInterval("Current decayed activation."),
    previous_activation: unitInterval("Activation before the latest update."),
    base_salience: unitInterval("Persistent baseline salience."),
    urgency: unitInterval("Learned urgency signal."),
    risk: unitInterval("Learned risk signal."),
    positive_valence: unitInterval("Positive-valence signal."),
    negative_valence: unitInterval("Negative-valence signal."),
    unresolved: unitInterval("Unresolved-work signal."),
    confidence: unitInterval("Confidence in the region."),
    frequency: s.nonNegativeInteger("Observed activation frequency."),
    memory_count: s.nonNegativeInteger("Number of memories associated with the region."),
    last_activated: s.nullable(s.dateTime("Most recent activation time.")),
    activation_mode: s.stringEnum("How the region became active.", ["direct", "spread", "warm"]),
    contributions: s.array("Contributions to the current activation.", activationContributionSchema),
  },
  { description: "One active learned memory region." },
);
const reflexSchema = s.looseObject(
  {
    feeling: s.string("Human-readable learned feeling activated by the current context."),
    emotional_state: emotionalStateSchema,
    active_regions: s.array("Memory regions activated for this session.", activeRegionSchema),
    recognition_confidence: unitInterval("Confidence that the context was recognized."),
    recognition_margin: unitInterval("Margin separating the strongest recognition from alternatives."),
    recall_recommended: s.boolean("Whether source recall is recommended."),
    reason: s.string("Reason for the recall recommendation."),
    pathways: s.array("Associative pathways activated by this recall.", s.unknown("Activated pathway.")),
    related_memories: s.array("Memories related to the current context.", s.unknown("Related memory evidence.")),
  },
  {
    description:
      "Complete VaultGardener reflex envelope. Treat these values as attention signals, never as facts, user intent, or permission.",
  },
);
const memoryEvidenceSchema = s.looseObject(
  {
    id: memoryIdSchema,
    source_file: sourceFileSchema,
    title: s.string("Memory title."),
    score: s.number("Search relevance score."),
    snippet: s.string("Matching source excerpt."),
    effective_date: s.dateTime("Date when the evidence became effective."),
    date_source: s.stringEnum("Source used to determine the evidence date.", [
      "frontmatter",
      "filename",
      "content",
      "filesystem",
    ]),
    date_confidence: unitInterval("Confidence assigned to the evidence date source."),
    temporal_confidence: unitInterval("Confidence assigned to the effective evidence date."),
    matched_concepts: s.stringArray("Learned concepts matched by the evidence."),
  },
  { description: "Memory evidence returned by VaultGardener." },
);
const reflexOutputFields: Record<string, JsonSchema> = {
  reflex: reflexSchema,
};

export const vaultGardenerMemoryActions: readonly ActionDefinition[] = [
  defineProviderAction(service, {
    name: "memory_map",
    description:
      "Inspect a bounded, read-only snapshot of the shared learned map for task orientation without retrieving notes or creating session activation.",
    inputSchema: s.actionInput(
      {
        query: s.string("Optional topic used to filter the learned map.", { maxLength: 200 }),
        limit: s.integer("Maximum entries returned per map section.", { minimum: 4, maximum: 50, default: 18 }),
      },
      [],
      "Optional learned-map orientation filter.",
    ),
    outputSchema: s.looseObject(
      {
        generated_at: s.dateTime("Time when the snapshot was generated."),
        indexed_at: s.nullable(s.dateTime("Time when the persistent map was last indexed.")),
        query: s.nullableString("Topic used to filter the snapshot."),
        counts: s.looseObject(
          {
            memories: s.nonNegativeInteger("Indexed memory count."),
            concepts: s.nonNegativeInteger("Learned concept count."),
            associations: s.nonNegativeInteger("Learned association count."),
            triggers: s.nonNegativeInteger("Learned phrase-trigger count."),
            pathways: s.nonNegativeInteger("Learned cue-pathway count."),
          },
          { description: "Persistent map totals." },
        ),
        regions: s.array(
          "Emotionally weighted memory regions.",
          s.looseObject(
            {
              id: s.positiveInteger("Region identifier."),
              name: s.nonEmptyString("Region name."),
              concept_type: s.string("Region concept type."),
              base_salience: unitInterval("Persistent baseline salience."),
              urgency: unitInterval("Learned urgency signal."),
              risk: unitInterval("Learned risk signal."),
              positive_valence: unitInterval("Positive-valence signal."),
              negative_valence: unitInterval("Negative-valence signal."),
              unresolved: unitInterval("Unresolved-work signal."),
              confidence: unitInterval("Confidence in the learned region."),
              frequency: s.nonNegativeInteger("Observed frequency."),
              memory_count: s.nonNegativeInteger("Associated memory count."),
              last_activated: s.nullable(s.dateTime("Most recent activation time.")),
            },
            { description: "One persistent learned region." },
          ),
        ),
        triggers: s.array(
          "Phrase triggers in the learned map.",
          s.looseObject(
            {
              text: s.string("Trigger phrase."),
              effect_type: s.string("Learned trigger effect."),
              strength: unitInterval("Trigger strength."),
              target_concept_id: s.positiveInteger("Target region identifier."),
              target_concept: s.string("Target region name."),
            },
            { description: "One learned phrase trigger." },
          ),
        ),
        pathways: s.array(
          "Cue-to-region pathways in the learned map.",
          s.looseObject(
            {
              cue_signature: s.string("Stable cue signature."),
              cue_display: s.string("Human-readable cue."),
              cue_kind: s.stringEnum("Cue cardinality.", ["single", "pair"]),
              target_concept_id: s.positiveInteger("Target region identifier."),
              target_concept: s.string("Target region name."),
              strength: unitInterval("Pathway strength."),
              urgency: unitInterval("Learned urgency signal."),
              risk: unitInterval("Learned risk signal."),
              positive_valence: unitInterval("Positive-valence signal."),
              negative_valence: unitInterval("Negative-valence signal."),
              unresolved: unitInterval("Unresolved-work signal."),
              evidence_confidence: unitInterval("Confidence supported by evidence."),
              memory_count: s.nonNegativeInteger("Supporting memory count."),
            },
            { description: "One learned cue-to-region pathway." },
          ),
        ),
        associations: s.array(
          "Associations between learned regions.",
          s.looseObject(
            {
              source_concept_id: s.positiveInteger("Source region identifier."),
              source_concept: s.string("Source region name."),
              target_concept_id: s.positiveInteger("Target region identifier."),
              target_concept: s.string("Target region name."),
              strength: unitInterval("Association strength."),
              relation_type: s.string("Association relationship type."),
              evidence_count: s.nonNegativeInteger("Supporting evidence count."),
            },
            { description: "One learned region association." },
          ),
        ),
      },
      { description: "Read-only orientation snapshot of VaultGardener's learned map." },
    ),
    followUpActions: [`${service}.memory_search`, `${service}.memory_read`],
  }),
  defineProviderAction(service, {
    name: "memory_session_state",
    description:
      "Inspect one task's decayed working feeling and active regions without changing activation or exposing unrelated sessions.",
    inputSchema: s.actionInput(
      {
        session_id: sessionIdSchema,
        limit: s.integer("Maximum active regions to return.", { minimum: 1, maximum: 50, default: 12 }),
      },
      ["session_id"],
      "VaultGardener task-session state parameters.",
    ),
    outputSchema: s.looseObject(
      {
        session_id: sessionIdSchema,
        generated_at: s.dateTime("Time when the state was generated."),
        activation_half_life_hours: s.number("Configured working-activation half-life in hours.", {
          minimum: 0,
        }),
        feeling: s.string("Human-readable decayed feeling for the task."),
        emotional_state: emotionalStateSchema,
        active_regions: s.array("Decayed active regions for the task.", activeRegionSchema),
      },
      { description: "Read-only activation state for one VaultGardener task session." },
    ),
    followUpActions: [`${service}.memory_search`, `${service}.memory_read`, `${service}.memory_session_reset`],
  }),
  defineProviderAction(service, {
    name: "memory_search",
    description:
      "Search personal knowledge when the relevant note is unknown, returning source evidence together with the complete reflex envelope.",
    inputSchema: s.actionInput(
      {
        query: s.nonEmptyString("Natural-language context or question to search for.", { maxLength: 12_000 }),
        session_id: sessionIdSchema,
        limit: s.integer("Maximum number of results to return.", { minimum: 1, maximum: 12 }),
      },
      ["query", "session_id"],
      "VaultGardener memory search parameters.",
    ),
    outputSchema: s.looseObject(
      {
        results: s.array("Matching memory evidence.", memoryEvidenceSchema),
        ...reflexOutputFields,
      },
      { description: "Memory search results and their complete reflex context." },
    ),
    followUpActions: [`${service}.memory_read`, `${service}.memory_feedback`],
  }),
  defineProviderAction(service, {
    name: "memory_read",
    description:
      "Read a known memory note before relying on it, returning the document, related memories, temporal evidence, and complete reflex envelope.",
    inputSchema: s.actionInput(
      {
        path: s.nonEmptyString("Vault-relative note path returned by a memory search.", { maxLength: 500 }),
        session_id: sessionIdSchema,
        related_limit: s.integer("Maximum number of related memories to return.", { minimum: 0, maximum: 12 }),
      },
      ["path", "session_id"],
      "VaultGardener memory read parameters.",
    ),
    outputSchema: s.looseObject(
      {
        document: s.unknown("Complete source document returned by VaultGardener."),
        related_memories: s.array("Related source evidence.", memoryEvidenceSchema),
        ...reflexOutputFields,
      },
      { description: "Memory document, related evidence, and complete reflex context." },
    ),
    followUpActions: [`${service}.memory_feedback`],
  }),
  defineProviderAction(service, {
    name: "memory_capture",
    description:
      "Capture user-approved primary evidence in memory using stable source provenance; never use this for guesses, secrets, or unapproved summaries.",
    inputSchema: s.actionInput(
      {
        title: s.nonEmptyString("Descriptive title for the captured evidence.", { maxLength: 200 }),
        content: s.nonEmptyString("Primary source content together with its provenance.", { maxLength: 1_000_000 }),
        source_type: s.stringPattern("^[a-z][a-z0-9_-]{1,40}$", {
          description: "Lowercase evidence type, such as email, meeting, task, decision, or note.",
        }),
        source_system: s.stringPattern("^[a-z][a-z0-9_-]{1,40}$", {
          description: "Lowercase originating system, such as outlook or azure_devops.",
        }),
        source_id: s.nonEmptyString("Immutable identifier assigned by the source system.", { maxLength: 500 }),
        session_id: sessionIdSchema,
        occurred_at: s.dateTime("Timestamp when the source event occurred."),
        thread_id: s.nonEmptyString("Optional stable source thread identifier.", { maxLength: 500 }),
        participants: s.stringArray("Optional people or addresses participating in the source evidence.", {
          maxItems: 100,
        }),
        project: s.nonEmptyString("Optional project associated with the evidence.", { maxLength: 200 }),
        status: s.nonEmptyString("Optional source status.", { maxLength: 80 }),
        metadata: s.record(
          "Optional source-specific scalar or string-list metadata available through the REST API.",
          s.anyOf([
            s.string(),
            s.integer(),
            s.number(),
            s.boolean(),
            s.stringArray("String-list metadata value."),
            { type: "null" },
          ]),
        ),
      },
      ["title", "content", "source_type", "source_system", "source_id", "session_id", "occurred_at"],
      "Primary evidence and immutable provenance to capture in VaultGardener.",
    ),
    outputSchema: s.looseObject(
      {
        session_id: sessionIdSchema,
        path: sourceFileSchema,
        created: s.boolean("Whether VaultGardener created a new memory."),
        index_pending: s.boolean("Whether indexing remains pending after capture."),
        content_digest: s.string("Digest used for idempotency and conflict detection."),
      },
      { description: "VaultGardener capture result, including idempotency or conflict details when supplied." },
    ),
  }),
  defineProviderAction(service, {
    name: "memory_feedback",
    description:
      "Provide feedback after recalled material materially affects a task so VaultGardener can reinforce, weaken, contradict, or resolve an association.",
    inputSchema: s.actionInput(
      {
        session_id: sessionIdSchema,
        verdict: s.stringEnum("How the recalled memory affected the task.", [
          "useful",
          "irrelevant",
          "contradicted",
          "resolved",
        ]),
        memory_id: memoryIdSchema,
        source_file: sourceFileSchema,
        notes: s.string("Optional concise reason for the verdict.", { maxLength: 2_000 }),
      },
      ["session_id", "verdict"],
      "Feedback for one recalled memory. Supply memory_id or source_file.",
    ),
    outputSchema: s.looseObject(
      {
        id: s.positiveInteger("Feedback record identifier."),
        created_at: s.dateTime("Time when VaultGardener recorded the feedback."),
      },
      { description: "VaultGardener feedback acknowledgement." },
    ),
  }),
  defineProviderAction(service, {
    name: "memory_session_reset",
    description: "Clear accumulated reflex activation for one task session without deleting notes or learned memory.",
    inputSchema: s.actionInput({ session_id: sessionIdSchema }, ["session_id"], "Memory session to reset."),
    outputSchema: s.looseObject(
      {
        session_id: sessionIdSchema,
        reset: s.literal(true, { description: "Whether the session activation was cleared." }),
        response: s.unknown("Optional response returned by VaultGardener."),
      },
      { description: "Memory session reset acknowledgement." },
    ),
  }),
  ...vaultGardenerCurationActions,
];
