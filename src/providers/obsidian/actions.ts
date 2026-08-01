import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "obsidian";

const notePathSchema = s.nonEmptyString(
  "Exact vault-relative note path, including the file extension (for example, Projects/Website.md).",
);
const durationSchema = s.integer("Time spent executing the Obsidian CLI command, in milliseconds.", { minimum: 0 });
const mutationOutputSchema = s.object("Result of an Obsidian note mutation.", {
  path: notePathSchema,
  message: s.string("Status text returned by the Obsidian CLI."),
  durationMs: durationSchema,
});

const listFilesInputSchema = s.object(
  "Filters for listing files in the configured Obsidian vault.",
  {
    folder: s.nonEmptyString("Optional vault-relative folder whose files should be listed."),
    extension: s.nonEmptyString("Optional file extension filter, with or without a leading dot."),
  },
  { optional: ["folder", "extension"] },
);

const listFilesOutputSchema = s.object("Files found in the configured Obsidian vault.", {
  files: s.array("Vault-relative file paths.", notePathSchema),
  total: s.integer("Number of returned files.", { minimum: 0 }),
  durationMs: durationSchema,
});

const searchNotesInputSchema = s.object(
  "Text search parameters for the configured Obsidian vault.",
  {
    query: s.nonEmptyString("Text to search for in the vault."),
    folder: s.nonEmptyString("Optional vault-relative folder that limits the search."),
    limit: s.integer("Maximum number of matching files to return.", { minimum: 1, maximum: 1000 }),
    caseSensitive: s.boolean("Whether matching should be case-sensitive."),
  },
  { optional: ["folder", "limit", "caseSensitive"] },
);

const searchNotesOutputSchema = s.object("Files whose contents match the requested text.", {
  matches: s.array("Vault-relative paths of matching files.", notePathSchema),
  total: s.integer("Number of returned matches.", { minimum: 0 }),
  durationMs: durationSchema,
});

const readNoteInputSchema = s.object("The note to read from the configured Obsidian vault.", {
  path: notePathSchema,
});

const readNoteOutputSchema = s.object("Contents of an Obsidian note.", {
  path: notePathSchema,
  content: s.string("Complete note contents, including frontmatter when present."),
  durationMs: durationSchema,
});

const writeNoteInputSchema = s.object("The note to create or completely replace.", {
  path: notePathSchema,
  content: s.string("Complete content to write to the note. An empty string clears an existing note."),
});

const extendNoteInputSchema = s.object(
  "The note content to add.",
  {
    path: notePathSchema,
    content: s.nonEmptyString("Content to add to the note."),
    inline: s.boolean("Whether to add the content without an automatic newline."),
  },
  { optional: ["inline"] },
);

export const obsidianActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "list_files",
    description: "List files in an Obsidian vault, optionally limited to a folder or file extension.",
    inputSchema: listFilesInputSchema,
    outputSchema: listFilesOutputSchema,
  }),
  defineProviderAction(service, {
    name: "search_notes",
    description: "Search note contents and return the vault-relative paths of matching files.",
    inputSchema: searchNotesInputSchema,
    outputSchema: searchNotesOutputSchema,
  }),
  defineProviderAction(service, {
    name: "read_note",
    description: "Read the complete contents of one note by its exact vault-relative path.",
    inputSchema: readNoteInputSchema,
    outputSchema: readNoteOutputSchema,
  }),
  defineProviderAction(service, {
    name: "write_note",
    description: "Create a note or completely replace an existing note at an exact vault-relative path.",
    inputSchema: writeNoteInputSchema,
    outputSchema: mutationOutputSchema,
  }),
  defineProviderAction(service, {
    name: "append_note",
    description: "Append content to an existing Obsidian note.",
    inputSchema: extendNoteInputSchema,
    outputSchema: mutationOutputSchema,
  }),
  defineProviderAction(service, {
    name: "prepend_note",
    description: "Prepend content to an existing Obsidian note after its frontmatter.",
    inputSchema: extendNoteInputSchema,
    outputSchema: mutationOutputSchema,
  }),
];
