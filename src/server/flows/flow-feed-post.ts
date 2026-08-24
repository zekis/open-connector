import type { FlowFeedImageMotif, FlowFeedImagePalette, FlowFeedPost } from "./flow-types.ts";

export const flowFeedImageMotifs: FlowFeedImageMotif[] = [
  "automation",
  "calendar",
  "chart",
  "document",
  "files",
  "message",
  "people",
  "success",
  "warning",
];

export const flowFeedImagePalettes: FlowFeedImagePalette[] = ["amber", "blue", "rose", "slate", "teal", "violet"];

/** Validate and normalize model-authored Feed presentation before it reaches storage or the UI. */
export function normalizeFlowFeedPost(value: unknown): FlowFeedPost | undefined {
  const feedPost = record(value);
  const image = record(feedPost?.image);
  const text = textField(feedPost, "text");
  const alt = textField(image, "alt");
  const headline = textField(image, "headline");
  const motif = image?.motif;
  const palette = image?.palette;
  if (!text || !alt || !headline || !isFeedImageMotif(motif) || !isFeedImagePalette(palette)) return undefined;
  return {
    text: normalizeFeedPostText(text),
    image: {
      alt: normalizeFeedCopy(alt, 180),
      headline: normalizeFeedCopy(headline, 64),
      motif,
      palette,
    },
  };
}

function normalizeFeedPostText(value: string): string {
  const normalized = normalizeFeedCopy(value, 220);
  const withoutStockOpening = normalized.replace(/^(all sorted|quick update|here(?:'|’)s the update)[,:.!\s-]*/i, "");
  const natural = withoutStockOpening || normalized;
  return natural ? `${natural[0]!.toLocaleUpperCase()}${natural.slice(1)}` : natural;
}

export function normalizeFeedCopy(value: string, maximum: number): string {
  return value
    .replaceAll(/\s*[—–]+\s*/g, ", ")
    .replaceAll(/\s+/g, " ")
    .replaceAll(/([.!?]),/g, "$1")
    .replaceAll(/\s+([,.!?])/g, "$1")
    .trim()
    .slice(0, maximum)
    .trim();
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function textField(value: Record<string, unknown> | undefined, field: string): string | undefined {
  const fieldValue = value?.[field];
  return typeof fieldValue === "string" && fieldValue.trim() ? fieldValue.trim() : undefined;
}

function isFeedImageMotif(value: unknown): value is FlowFeedImageMotif {
  return typeof value === "string" && flowFeedImageMotifs.includes(value as FlowFeedImageMotif);
}

function isFeedImagePalette(value: unknown): value is FlowFeedImagePalette {
  return typeof value === "string" && flowFeedImagePalettes.includes(value as FlowFeedImagePalette);
}
