/**
 * The actual markdown renderer — `react-markdown` plus `remark-gfm`.
 *
 * T5.3 (admin latency plan): this was the body of `Markdown.tsx`, and that
 * file is imported statically by `chat.tsx`, `CandidateStage.tsx` and
 * `KitGallery.tsx` — so every admin route that can show a chat dock pulled
 * the whole markdown stack into its first-paint bundle whether or not a
 * single message was ever rendered. Split out here and loaded through
 * `React.lazy` from `Markdown.tsx`, it becomes its own chunk, fetched the
 * first time a page actually has markdown to draw. Nothing about the
 * rendering changed; the default export is what `lazy()` needs.
 */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { safeMarkdownUrl } from '@core/lib/admin/markdown';

export default function MarkdownRenderer({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      urlTransform={safeMarkdownUrl}
      components={{
        a: ({ children: linkChildren, href }) =>
          href ? (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {linkChildren}
            </a>
          ) : (
            <span>{linkChildren}</span>
          ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
