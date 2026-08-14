import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "vaultgardener_memory";

const curationActions = [
  "archive",
  "mark_historical",
  "flag_duplicate",
  "flag_conflict",
  "flag_superseded",
  "needs_review",
  "keep_active",
];
const curationProposalStatuses = ["pending", "approved", "rejected", "applied", "failed", "undone", "stale"];
const unitInterval = (description: string): JsonSchema => s.number(description, { minimum: 0, maximum: 1 });
const optionalDateTime = (description: string): JsonSchema => s.nullable(s.dateTime(description));

const curationProposalSchema = s.looseObject(
  {
    id: s.positiveInteger("Curation proposal identifier."),
    review_id: s.positiveInteger("Review that produced the proposal."),
    source_file: s.nonEmptyString("Vault-relative source note path."),
    source_hash: s.nonEmptyString("Source hash used for stale-change protection."),
    action: s.stringEnum("Proposed lifecycle action.", curationActions),
    target_path: s.nullableString("Destination path for actions that move a note."),
    confidence: unitInterval("Confidence assigned to the proposal."),
    reason: s.string("Reason for the proposal."),
    evidence: s.stringArray("Evidence supporting the proposal."),
    related_files: s.stringArray("Vault-relative notes related to the proposal."),
    status: s.stringEnum("Current proposal lifecycle status.", curationProposalStatuses),
    created_at: s.dateTime("Time when the proposal was created."),
    decided_at: optionalDateTime("Time when the proposal was decided."),
    decided_by: s.nullableString("Identity that made the decision."),
    decision_notes: s.nullableString("Notes recorded with the decision."),
    applied_at: optionalDateTime("Time when the proposal was applied."),
  },
  { description: "One guarded and auditable VaultGardener curation proposal." },
);

const curationJobSchema = s.looseObject(
  {
    id: s.positiveInteger("Curation job identifier."),
    source_file: s.nonEmptyString("Vault-relative source note path."),
    source_hash: s.nonEmptyString("Source hash queued for analysis."),
    policy_version: s.string("Curation policy version."),
    status: s.stringEnum("Background job status.", [
      "pending",
      "running",
      "completed",
      "failed",
      "cancelled",
      "skipped",
    ]),
    attempts: s.nonNegativeInteger("Processing attempts made."),
    max_attempts: s.positiveInteger("Maximum processing attempts."),
    available_at: s.dateTime("Time when the job became available."),
    created_at: s.dateTime("Time when the job was created."),
    updated_at: s.dateTime("Time when the job was last updated."),
    started_at: optionalDateTime("Time when processing started."),
    finished_at: optionalDateTime("Time when processing finished."),
    error: s.nullableString("Latest processing error."),
  },
  { description: "Durable background curation job." },
);

const curationReviewSchema = s.looseObject(
  {
    id: s.positiveInteger("Curation review identifier."),
    job_id: s.nullableInteger("Background job that produced the review."),
    source_file: s.nonEmptyString("Vault-relative source note path."),
    source_hash: s.nonEmptyString("Source hash reviewed."),
    policy_version: s.string("Curation policy version."),
    summary: s.string("Review summary."),
    static_knowledge: s.array(
      "Stable knowledge extracted from the source note.",
      s.looseObject(
        {
          statement: s.string("Extracted statement."),
          kind: s.stringEnum("Knowledge kind.", ["stable_fact", "decision", "status", "constraint", "ownership"]),
          confidence: unitInterval("Extraction confidence."),
          source_excerpt: s.string("Source excerpt supporting the statement."),
        },
        { description: "One extracted knowledge statement." },
      ),
    ),
    reflex: s.looseObject(
      "Complete VaultGardener reflex envelope returned beside the review evidence; preserve it in context.",
    ),
    relationships: s.array(
      "Relationships detected between notes.",
      s.looseObject(
        {
          related_file: s.nonEmptyString("Vault-relative related note path."),
          relation: s.stringEnum("Relationship type.", [
            "supports",
            "contradicts",
            "duplicates",
            "extends",
            "supersedes",
          ]),
          confidence: unitInterval("Relationship confidence."),
          reason: s.string("Reason for the relationship."),
          source_effective_date: optionalDateTime("Source note effective date."),
          related_effective_date: optionalDateTime("Related note effective date."),
        },
        { description: "One detected note relationship." },
      ),
    ),
    attachments: s.array(
      "Attachments inspected during review.",
      s.looseObject(
        {
          path: s.nonEmptyString("Vault-relative attachment path."),
          kind: s.stringEnum("Attachment kind.", ["image", "pdf", "audio", "video", "document", "other"]),
          exists: s.boolean("Whether the attachment exists."),
          size_bytes: s.nullableInteger("Attachment size in bytes."),
          extracted_text: s.nullableString("Text extracted from the attachment."),
          warning: s.nullableString("Attachment inspection warning."),
        },
        { description: "One attachment associated with the reviewed note." },
      ),
    ),
    prompt_injection_risk: s.boolean("Whether the source matched a prompt-injection safety signal."),
    confidence: unitInterval("Overall review confidence."),
    analysis_method: s.stringEnum("Analysis method.", ["deterministic", "ollama", "hybrid"]),
    created_at: s.dateTime("Time when the review was created."),
  },
  { description: "Static knowledge, reflex signals, relationships, attachments, and safety findings for one note." },
);

export const vaultGardenerCurationActions: readonly ActionDefinition[] = [
  defineProviderAction(service, {
    name: "curation_status",
    description: "Inspect the durable curation queue and proposal counts without changing source notes.",
    inputSchema: s.actionInput({}, [], "No input is required."),
    outputSchema: s.looseObject(
      {
        enabled: s.boolean("Whether curation is enabled."),
        running: s.boolean("Whether the background curator is running."),
        pending: s.nonNegativeInteger("Queued job count."),
        processing: s.nonNegativeInteger("Processing job count."),
        completed: s.nonNegativeInteger("Completed job count."),
        failed: s.nonNegativeInteger("Failed job count."),
        proposals_pending: s.nonNegativeInteger("Pending proposal count."),
        proposals_applied: s.nonNegativeInteger("Applied proposal count."),
        proposals_rejected: s.nonNegativeInteger("Rejected proposal count."),
        last_error: s.nullableString("Latest background curation error."),
      },
      { description: "Current VaultGardener curation queue state." },
    ),
    followUpActions: [`${service}.curation_list`],
  }),
  defineProviderAction(service, {
    name: "curation_scan",
    description:
      "Queue bounded curation analysis for selected notes, or the eligible vault when paths are omitted, without applying lifecycle changes.",
    inputSchema: s.actionInput(
      {
        paths: s.stringArray("Optional vault-relative note paths to scan.", { maxItems: 5_000 }),
        force: s.boolean({
          description: "Whether to requeue notes whose current source hash was already considered.",
          default: false,
        }),
      },
      [],
      "Curation scan selection.",
    ),
    outputSchema: s.actionOutput(
      {
        considered: s.nonNegativeInteger("Eligible notes considered."),
        queued: s.nonNegativeInteger("Reviews newly queued."),
        deduplicated: s.nonNegativeInteger("Already queued or reviewed source hashes skipped."),
      },
      "Curation scan queue result.",
    ),
    followUpActions: [`${service}.curation_status`, `${service}.curation_review`],
  }),
  defineProviderAction(service, {
    name: "curation_review",
    description:
      "Read the current static knowledge, reflex envelope, relationships, attachments, and proposals for one note; optionally queue analysis when missing.",
    inputSchema: s.actionInput(
      {
        path: s.nonEmptyString("Vault-relative note path to review.", { maxLength: 500 }),
        enqueue_if_missing: s.boolean({
          description: "Whether to queue analysis when no review exists for the current source hash.",
          default: true,
        }),
      },
      ["path"],
      "Curation review lookup.",
    ),
    outputSchema: s.looseObject(
      {
        job: s.nullable(curationJobSchema),
        review: s.nullable(curationReviewSchema),
        proposals: s.array("Lifecycle proposals produced by the review.", curationProposalSchema),
        queued: s.boolean("Whether missing analysis was queued."),
      },
      { description: "Current review and proposal state for one note." },
    ),
    followUpActions: [`${service}.curation_status`, `${service}.curation_list`],
  }),
  defineProviderAction(service, {
    name: "curation_list",
    description: "List lifecycle proposals without approving, rejecting, applying, or undoing them.",
    inputSchema: s.actionInput(
      {
        status: s.stringEnum("Proposal status filter.", ["all", ...curationProposalStatuses]),
        action: s.stringEnum("Proposed action filter.", curationActions),
        limit: s.integer("Maximum proposals to return.", { minimum: 1, maximum: 200, default: 50 }),
        offset: s.nonNegativeInteger("Zero-based result offset.", { default: 0 }),
      },
      [],
      "Curation proposal filters and pagination.",
    ),
    outputSchema: s.actionOutput(
      {
        proposals: s.array("Matching lifecycle proposals.", curationProposalSchema),
        total: s.nonNegativeInteger("Total matching proposal count."),
      },
      "Filtered curation proposals.",
    ),
    followUpActions: [
      `${service}.curation_review`,
      `${service}.curation_approve`,
      `${service}.curation_reject`,
      `${service}.curation_undo`,
    ],
  }),
  defineProviderAction(service, {
    name: "curation_approve",
    description:
      "Approve one guarded curation proposal and optionally apply it; this is a user decision and must run only with explicit user direction.",
    inputSchema: s.actionInput(
      {
        proposal_id: s.positiveInteger("Proposal to approve."),
        reviewed_by: s.nonEmptyString("Auditable identity making the decision.", { maxLength: 160 }),
        notes: s.string("Optional decision notes.", { maxLength: 2_000 }),
        apply: s.boolean({
          description: "Whether to apply the lifecycle change immediately after approval.",
          default: true,
        }),
      },
      ["proposal_id", "reviewed_by"],
      "Explicit curation approval decision.",
    ),
    outputSchema: curationProposalSchema,
    followUpActions: [`${service}.curation_review`, `${service}.curation_undo`],
  }),
  defineProviderAction(service, {
    name: "curation_reject",
    description:
      "Reject one curation proposal without changing its source note; this is a user decision and must run only with explicit user direction.",
    inputSchema: s.actionInput(
      {
        proposal_id: s.positiveInteger("Proposal to reject."),
        reviewed_by: s.nonEmptyString("Auditable identity making the decision.", { maxLength: 160 }),
        notes: s.string("Optional decision notes.", { maxLength: 2_000 }),
      },
      ["proposal_id", "reviewed_by"],
      "Explicit curation rejection decision.",
    ),
    outputSchema: curationProposalSchema,
    followUpActions: [`${service}.curation_review`, `${service}.curation_list`],
  }),
  defineProviderAction(service, {
    name: "curation_undo",
    description:
      "Undo one applied curation action when its target is unchanged; this is a user decision and must run only with explicit user direction.",
    inputSchema: s.actionInput(
      {
        proposal_id: s.positiveInteger("Applied proposal to undo."),
        requested_by: s.nonEmptyString("Auditable identity requesting the undo.", { maxLength: 160 }),
        notes: s.string("Optional undo notes.", { maxLength: 2_000 }),
      },
      ["proposal_id", "requested_by"],
      "Explicit curation undo decision.",
    ),
    outputSchema: curationProposalSchema,
    followUpActions: [`${service}.curation_review`, `${service}.curation_list`],
  }),
];
