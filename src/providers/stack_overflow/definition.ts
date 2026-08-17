import type { ProviderDefinition } from "../../core/types.ts";

import { stackOverflowActions } from "./actions.ts";

const service = "stack_overflow";

/** PAT-authenticated Stack Overflow Internal provider backed by the hosted v2.3 API. */
export const provider: ProviderDefinition = {
  service,
  displayName: "Stack Overflow Internal",
  description: "Search and contribute to a private Stack Overflow Internal team using a personal access token.",
  categories: ["Developer Tools", "Productivity"],
  authTypes: ["api_key"],
  auth: [
    {
      type: "api_key",
      label: "Personal access token",
      placeholder: "Stack Overflow PAT",
      description:
        "Personal access token sent in the X-API-Access-Token header. Enable write access on the token to create questions, answers, and comments.",
      extraFields: [
        {
          key: "team",
          label: "Team slug",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "my-team",
          description: "Slug from your team URL, such as my-team in stackoverflowteams.com/c/my-team.",
        },
      ],
    },
  ],
  homepageUrl: "https://stackoverflow.co/internal/",
  events: [
    {
      id: "stack_overflow.new_question",
      displayName: "New question",
      description: "Runs when a new question is posted to the configured Stack Overflow Internal team.",
      polling: {
        actionId: "stack_overflow.list_questions",
        input: { pageSize: 50, order: "desc", sort: "creation" },
        result: { kind: "records", collectionField: "questions", idFields: ["question_id"] },
      },
    },
  ],
  actions: stackOverflowActions,
};
