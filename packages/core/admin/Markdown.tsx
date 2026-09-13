/**
 * The markdown seam every admin surface renders through.
 *
 * T5.3 (admin latency plan): the renderer itself (`react-markdown` +
 * `remark-gfm`) now lives in `MarkdownRenderer.tsx` behind `React.lazy`, so
 * it is a chunk fetched on first use rather than weight carried by every
 * route that merely CAN show a chat. Call sites are unchanged — this
 * component still takes a markdown string and renders it into `.adm-prose`.
 *
 * The fallback is the source text, wrapped, not a spinner: while the chunk
 * is in flight a message is still readable, and the swap to rendered
 * markdown is the only thing anyone sees happen.
 */
import { lazy, Suspense } from 'react';

const MarkdownRenderer = lazy(() => import('./MarkdownRenderer'));

export function Markdown({ children }: { children: string }) {
  return (
    <div className="adm-prose">
      <Suspense fallback={<p className="whitespace-pre-wrap">{children}</p>}>
        <MarkdownRenderer>{children}</MarkdownRenderer>
      </Suspense>
    </div>
  );
}
