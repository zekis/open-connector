import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "stack_overflow";
const writeAccess = ["write_access"];

interface StackOverflowActionSource {
  name: string;
  description: string;
  providerPermissions: string[];
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  followUpActions?: string[];
}

const user = s.looseObject(
  {
    user_id: s.positiveInteger("Team user ID."),
    account_id: s.nonNegativeInteger("Stack Exchange network account ID."),
    display_name: s.nonEmptyString("User display name."),
    reputation: s.nonNegativeInteger("User reputation."),
    user_type: s.string("User type."),
    profile_image: s.url("Profile image URL."),
    link: s.url("User profile URL."),
  },
  { description: "Stack Overflow Internal user." },
);

const question = s.looseObject(
  {
    question_id: s.positiveInteger("Question ID."),
    accepted_answer_id: s.positiveInteger("Accepted answer ID."),
    title: s.nonEmptyString("Question title."),
    body: s.string("Rendered question body."),
    tags: s.stringArray("Question tags."),
    link: s.url("Question URL."),
    owner: user,
    is_answered: s.boolean("Whether the question is considered answered."),
    answer_count: s.nonNegativeInteger("Number of answers."),
    comment_count: s.nonNegativeInteger("Number of comments."),
    score: s.integer("Question score."),
    view_count: s.nonNegativeInteger("Question view count."),
    creation_date: s.nonNegativeInteger("Question creation time as Unix epoch seconds."),
    last_activity_date: s.nonNegativeInteger("Last activity time as Unix epoch seconds."),
    last_edit_date: s.nonNegativeInteger("Last edit time as Unix epoch seconds."),
  },
  { description: "Stack Overflow Internal question." },
);

const answer = s.looseObject(
  {
    answer_id: s.positiveInteger("Answer ID."),
    question_id: s.positiveInteger("Parent question ID."),
    body: s.string("Rendered answer body."),
    link: s.url("Answer URL."),
    owner: user,
    is_accepted: s.boolean("Whether the answer is accepted."),
    score: s.integer("Answer score."),
    creation_date: s.nonNegativeInteger("Answer creation time as Unix epoch seconds."),
    last_activity_date: s.nonNegativeInteger("Last activity time as Unix epoch seconds."),
    last_edit_date: s.nonNegativeInteger("Last edit time as Unix epoch seconds."),
  },
  { description: "Stack Overflow Internal answer." },
);

const comment = s.looseObject(
  {
    comment_id: s.positiveInteger("Comment ID."),
    post_id: s.positiveInteger("Question or answer ID receiving the comment."),
    post_type: s.stringEnum(["question", "answer", "article"], { description: "Parent post type." }),
    body: s.string("Rendered comment body."),
    link: s.url("Comment URL."),
    owner: user,
    score: s.integer("Comment score."),
    creation_date: s.nonNegativeInteger("Comment creation time as Unix epoch seconds."),
    edited: s.boolean("Whether the comment was edited."),
  },
  { description: "Stack Overflow Internal comment." },
);

const tag = s.looseObject(
  {
    name: s.nonEmptyString("Tag name."),
    count: s.nonNegativeInteger("Number of questions using the tag."),
    is_required: s.boolean("Whether the team requires this tag."),
    is_moderator_only: s.boolean("Whether only moderators may use this tag."),
    has_synonyms: s.boolean("Whether the tag has synonyms."),
    last_activity_date: s.nonNegativeInteger("Last tag activity time as Unix epoch seconds."),
  },
  { description: "Stack Overflow Internal tag." },
);

const page = s.positiveInteger("One-based page number. Defaults to 1.");
const pageSize = s.integer("Maximum results per page. Defaults to 30.", { minimum: 1, maximum: 100 });
const fromDate = s.nonNegativeInteger("Only return items created or active after this Unix epoch timestamp.");
const toDate = s.nonNegativeInteger("Only return items created or active before this Unix epoch timestamp.");
const order = s.stringEnum(["asc", "desc"], { description: "Sort order. Defaults to desc." });
const filter = s.nonEmptyString("Stack Overflow API filter. Defaults to the built-in withbody filter.");
const tags = s.stringArray("Tag names.", { minItems: 1, maxItems: 5, itemDescription: "Tag name." });
const questionIds = s.array(s.positiveInteger("Question ID."), {
  description: "Question IDs. The API accepts up to 100 IDs per request.",
  minItems: 1,
  maxItems: 100,
});

const paginationFields = { page, pageSize };
const activityWindowFields = { fromDate, toDate, order };

const sources: StackOverflowActionSource[] = [
  {
    name: "get_current_user",
    description: "Get the Stack Overflow Internal user associated with the configured personal access token.",
    providerPermissions: [],
    inputSchema: actionInput({}),
    outputSchema: actionOutput({ user }),
  },
  {
    name: "search_questions",
    description: "Search private team questions by free text, title, body, tags, author, and answer state.",
    providerPermissions: [],
    inputSchema: actionInput(
      {
        q: s.nonWhitespaceString("Free-form search text."),
        title: s.nonWhitespaceString("Text that must appear in the question title."),
        body: s.nonWhitespaceString("Text that must appear in the question body."),
        tagged: tags,
        notTagged: tags,
        accepted: s.boolean("Require questions with or without an accepted answer."),
        answers: s.nonNegativeInteger("Minimum answer count."),
        closed: s.boolean("Require closed or open questions."),
        views: s.nonNegativeInteger("Minimum view count."),
        userId: s.positiveInteger("Only return questions owned by this user ID."),
        sort: s.stringEnum(["activity", "creation", "votes", "relevance"], {
          description: "Search result sort. Defaults to relevance.",
        }),
        ...activityWindowFields,
        ...paginationFields,
        filter,
      },
      ["q"],
    ),
    outputSchema: collectionOutput("questions", question),
    followUpActions: ["stack_overflow.get_questions", "stack_overflow.list_question_answers"],
  },
  {
    name: "list_questions",
    description: "List recent, active, highly voted, hot, weekly, or monthly questions from the private team.",
    providerPermissions: [],
    inputSchema: actionInput({
      tagged: tags,
      sort: s.stringEnum(["activity", "creation", "votes", "hot", "week", "month"], {
        description: "Question sort. Defaults to activity.",
      }),
      ...activityWindowFields,
      ...paginationFields,
      filter,
    }),
    outputSchema: collectionOutput("questions", question),
    followUpActions: ["stack_overflow.get_questions", "stack_overflow.list_question_answers"],
  },
  {
    name: "get_questions",
    description: "Get complete private team questions by ID, including their rendered bodies.",
    providerPermissions: [],
    inputSchema: actionInput({ questionIds, filter }, ["questionIds"]),
    outputSchema: collectionOutput("questions", question),
    followUpActions: ["stack_overflow.list_question_answers", "stack_overflow.add_comment"],
  },
  {
    name: "list_question_answers",
    description: "List answers for one or more private team questions.",
    providerPermissions: [],
    inputSchema: actionInput(
      {
        questionIds,
        sort: s.stringEnum(["activity", "creation", "votes"], {
          description: "Answer sort. Defaults to votes.",
        }),
        ...activityWindowFields,
        ...paginationFields,
        filter,
      },
      ["questionIds"],
    ),
    outputSchema: collectionOutput("answers", answer),
    followUpActions: ["stack_overflow.create_answer", "stack_overflow.add_comment"],
  },
  {
    name: "list_tags",
    description: "List tags available in the private team before searching or creating a question.",
    providerPermissions: [],
    inputSchema: actionInput({
      inName: s.nonWhitespaceString("Only return tags whose names contain this text."),
      sort: s.stringEnum(["popular", "activity", "name"], { description: "Tag sort. Defaults to popular." }),
      order,
      ...paginationFields,
    }),
    outputSchema: collectionOutput("tags", tag),
    followUpActions: ["stack_overflow.search_questions", "stack_overflow.create_question"],
  },
  {
    name: "create_question",
    description: "Create a question in the private team. The PAT must have write access enabled.",
    providerPermissions: writeAccess,
    inputSchema: actionInput(
      {
        title: s.nonWhitespaceString("Question title."),
        body: s.nonWhitespaceString("Question body using Stack Overflow Markdown."),
        tags,
      },
      ["title", "body", "tags"],
    ),
    outputSchema: actionOutput({ question }),
    followUpActions: ["stack_overflow.get_questions"],
  },
  {
    name: "create_answer",
    description: "Answer a private team question. The PAT must have write access enabled.",
    providerPermissions: writeAccess,
    inputSchema: actionInput(
      {
        questionId: s.positiveInteger("Question ID to answer."),
        body: s.nonWhitespaceString("Answer body using Stack Overflow Markdown."),
      },
      ["questionId", "body"],
    ),
    outputSchema: actionOutput({ answer }),
    followUpActions: ["stack_overflow.list_question_answers"],
  },
  {
    name: "add_comment",
    description: "Add a comment to a private team question or answer. The PAT must have write access enabled.",
    providerPermissions: writeAccess,
    inputSchema: actionInput(
      {
        postId: s.positiveInteger("Question or answer ID to comment on."),
        body: s.nonWhitespaceString("Comment text."),
      },
      ["postId", "body"],
    ),
    outputSchema: actionOutput({ comment }),
  },
];

export const stackOverflowActions: ActionDefinition[] = sources.map((source) =>
  defineProviderAction(service, {
    name: source.name,
    description: source.description,
    requiredScopes: [],
    providerPermissions: source.providerPermissions,
    inputSchema: source.inputSchema,
    outputSchema: source.outputSchema,
    followUpActions: source.followUpActions,
  }),
);

function actionInput(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return s.actionInput(properties, required, "Stack Overflow Internal action input.");
}

function actionOutput(properties: Record<string, JsonSchema>): JsonSchema {
  return s.actionOutput(properties, "Stack Overflow Internal action output.");
}

function collectionOutput(fieldName: string, item: JsonSchema): JsonSchema {
  return actionOutput({
    [fieldName]: s.array(item, { description: `Stack Overflow Internal ${fieldName}.` }),
    hasMore: s.boolean("Whether another page is available."),
    nextPage: s.nullableInteger("Next page number, or null when the collection is complete.", { minimum: 1 }),
    quotaRemaining: s.nullableInteger("Remaining API request quota, when reported.", { minimum: 0 }),
    quotaMax: s.nullableInteger("Maximum API request quota, when reported.", { minimum: 0 }),
    backoffSeconds: s.nullableInteger("Required delay before another equivalent request, when reported.", {
      minimum: 0,
    }),
  });
}
