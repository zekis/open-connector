import type { Definition, Nodes, Parents, Root } from "mdast";

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

interface TeamsMessageRenderContext {
  definitions: Map<string, Definition>;
}

/** Render agent Markdown as the safe HTML subset understood by Microsoft Teams messages. */
export function renderTeamsMessageHtml(markdown: string): string {
  const root = fromMarkdown(markdown.trim(), {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const context: TeamsMessageRenderContext = {
    definitions: new Map(
      root.children.flatMap((node) => (node.type === "definition" ? [[node.identifier, node]] : [])),
    ),
  };
  return root.children.map((node) => renderNode(node, context)).join("");
}

function renderNode(node: Nodes, context: TeamsMessageRenderContext): string {
  switch (node.type) {
    case "root":
      return renderChildren(node, context);
    case "paragraph":
      return `<p>${renderChildren(node, context)}</p>`;
    case "heading":
      return `<p><strong>${renderChildren(node, context)}</strong></p>`;
    case "blockquote":
      return `<blockquote>${renderChildren(node, context)}</blockquote>`;
    case "list":
      return `<${node.ordered ? "ol" : "ul"}>${renderChildren(node, context)}</${node.ordered ? "ol" : "ul"}>`;
    case "listItem": {
      const checked = node.checked == null ? "" : node.checked ? "☑ " : "☐ ";
      return `<li>${checked}${node.children.map((child) => renderListItemChild(child, context)).join("")}</li>`;
    }
    case "code":
      return `<pre><code>${escapeHtml(node.value)}</code></pre>`;
    case "thematicBreak":
      return "<hr>";
    case "table":
      return renderTable(node, context);
    case "tableRow":
      return `<tr>${renderChildren(node, context)}</tr>`;
    case "tableCell":
      return `<td>${renderChildren(node, context)}</td>`;
    case "text":
      return escapeHtml(node.value).replaceAll("\n", "<br>");
    case "strong":
      return `<strong>${renderChildren(node, context)}</strong>`;
    case "emphasis":
      return `<em>${renderChildren(node, context)}</em>`;
    case "delete":
      return `<s>${renderChildren(node, context)}</s>`;
    case "inlineCode":
      return `<code>${escapeHtml(node.value)}</code>`;
    case "break":
      return "<br>";
    case "link":
      return renderLink(node.url, renderChildren(node, context), node.title);
    case "linkReference": {
      const definition = context.definitions.get(node.identifier);
      return definition
        ? renderLink(definition.url, renderChildren(node, context), definition.title)
        : renderChildren(node, context);
    }
    case "image":
      return renderLink(node.url, escapeHtml(node.alt ?? "Image"), node.title);
    case "imageReference": {
      const definition = context.definitions.get(node.identifier);
      return definition
        ? renderLink(definition.url, escapeHtml(node.alt ?? "Image"), definition.title)
        : escapeHtml(node.alt ?? "Image");
    }
    case "footnoteReference":
      return `<sup>${escapeHtml(node.label ?? node.identifier)}</sup>`;
    case "footnoteDefinition":
      return `<p><sup>${escapeHtml(node.label ?? node.identifier)}</sup> ${renderChildren(node, context)}</p>`;
    case "definition":
    case "html":
    case "yaml":
      return "";
  }
}

function renderChildren(node: Root | Parents, context: TeamsMessageRenderContext): string {
  return node.children.map((child) => renderNode(child, context)).join("");
}

function renderListItemChild(node: Nodes, context: TeamsMessageRenderContext): string {
  return node.type === "paragraph" ? renderChildren(node, context) : renderNode(node, context);
}

function renderTable(node: Extract<Nodes, { type: "table" }>, context: TeamsMessageRenderContext): string {
  const [heading, ...rows] = node.children;
  const head = heading
    ? `<thead><tr>${heading.children.map((cell) => `<th>${renderChildren(cell, context)}</th>`).join("")}</tr></thead>`
    : "";
  const body = rows.length
    ? `<tbody>${rows
        .map((row) => `<tr>${row.children.map((cell) => `<td>${renderChildren(cell, context)}</td>`).join("")}</tr>`)
        .join("")}</tbody>`
    : "";
  return `<table>${head}${body}</table>`;
}

function renderLink(url: string, label: string, title?: string | null): string {
  if (!safeLink(url)) return label;
  const titleAttribute = title ? ` title="${escapeAttribute(title)}"` : "";
  return `<a href="${escapeAttribute(url)}"${titleAttribute}>${label}</a>`;
}

function safeLink(value: string): boolean {
  try {
    return ["https:", "http:", "mailto:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
