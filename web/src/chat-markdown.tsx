import type { ReactNode } from "react";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function ChatMarkdown(props: { children: string }): ReactNode {
  return (
    <div className="chat-markdown">
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a href={href} rel="noreferrer" target="_blank">
              {children}
            </a>
          ),
        }}
      >
        {props.children}
      </Markdown>
    </div>
  );
}
