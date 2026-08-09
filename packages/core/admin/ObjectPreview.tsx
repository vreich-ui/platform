/**
 * ObjectPreview (T9.10) — the workspace's "see what you're editing" pane, one
 * strategy per object type. Re-renders whenever its `record` prop changes, so
 * it refreshes after each accepted EditSession.patch (the workspace reloads the
 * record on accept).
 *
 * LEAK RULE: the content_item strategy renders public copy ONLY, via the shared
 * public renderer (see preview-logic.ts). No preview edits anything — it is a
 * read surface.
 *
 * v1 scope (per the brief): page/section preview is a structured, human-readable
 * view plus — for a published route — an iframe of the LIVE published page with
 * an "unpublished changes" notice. Pixel-true draft SSR is out of scope repo-
 * wide (the canvas has the same limitation), so a draft overlay is deliberately
 * not attempted here.
 */
import type { ReactNode } from 'react';

import { EmptyState, Badge } from './primitives';
import { IconInfo, IconExternalLink } from './icons';
import { navigationTargetLabel, objectTypeLabel } from '@core/lib/admin/display-name';
import {
  contentItemPreview,
  productPreview,
  tokenSwatches,
  tokenFonts,
  pageSectionLabel,
} from '@core/lib/admin/preview-logic';
import type { ObjectRecord } from '@core/schema/object-record-v1';

type Rec = ObjectRecord<Record<string, unknown>>;

const asBag = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[var(--adm-radius-lg)] border border-[var(--adm-border)] bg-[var(--adm-surface-raised)] p-4">
      {children}
    </div>
  );
}

function KeyRows({ rows }: { rows: Array<[string, ReactNode]> }) {
  const shown = rows.filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (shown.length === 0) return <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">—</p>;
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5">
      {shown.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-[length:var(--adm-text-xs)] font-medium uppercase tracking-wide text-[var(--adm-text-muted)]">
            {k}
          </dt>
          <dd className="text-[length:var(--adm-text-sm)] text-[var(--adm-text)]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ─── per-type strategies ───────────────────────────────────────────────────────

function ContentItemPreview({ record }: { record: Rec }) {
  const p = contentItemPreview(record);
  return (
    <Frame>
      <article className="mx-auto max-w-2xl">
        {p.image ? (
          <img
            src={p.image.src}
            alt={p.image.alt ?? ''}
            className="mb-4 w-full rounded-[var(--adm-radius-md)] object-cover"
          />
        ) : null}
        <h1 className="text-[length:var(--adm-text-2xl)] font-bold text-[var(--adm-text-heading)]">{p.title}</h1>
        {p.deck ? <p className="mt-2 text-[length:var(--adm-text-lg)] text-[var(--adm-text-muted)]">{p.deck}</p> : null}
        {p.description ? (
          <p className="mt-1 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">{p.description}</p>
        ) : null}
        {p.readingTime ? (
          <p className="mt-2 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">{p.readingTime} min read</p>
        ) : null}
        {p.error ? (
          <div className="mt-4">
            <EmptyState icon={<IconInfo size={22} />} title="Body not renderable yet" message={p.error} />
          </div>
        ) : (
          <div
            className="prose prose-sm mt-4 max-w-none dark:prose-invert"
            // Leak-safe: markup comes from renderArticleNodes (public fields only).
            dangerouslySetInnerHTML={{ __html: p.bodyHtml }}
          />
        )}
      </article>
    </Frame>
  );
}

function PagePreview({ record, focusId }: { record: Rec; focusId?: string }) {
  const body = asBag(record.body);
  const route = str(body.route);
  const published = str(record.publication?.published_time ?? undefined);
  const sections = Array.isArray(body.sections) ? body.sections : [];

  return (
    <div className="flex flex-col gap-4">
      <Frame>
        <KeyRows
          rows={[
            ['Title', str(body.title)],
            ['Route', route ? <code>{route}</code> : undefined],
            ['Page type', str(body.pageType)],
            ['Sections', String(sections.length)],
          ]}
        />
        <div className="mt-3">
          <p className="mb-1 text-[length:var(--adm-text-xs)] font-medium uppercase tracking-wide text-[var(--adm-text-muted)]">
            Section order
          </p>
          <ol className="flex flex-col gap-1">
            {sections.map((raw, i) => {
              const label = pageSectionLabel(raw, i);
              const sectionId = str(asBag(raw).id);
              const focused = Boolean(focusId && sectionId === focusId);
              return (
                <li
                  key={i}
                  className={
                    focused
                      ? 'rounded-[var(--adm-radius-md)] border border-[var(--adm-accent)] bg-[var(--adm-accent-soft)] px-3 py-1.5 text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text)]'
                      : 'rounded-[var(--adm-radius-md)] bg-[var(--adm-surface-sunken)] px-3 py-1.5 text-[length:var(--adm-text-sm)] text-[var(--adm-text)]'
                  }
                  aria-current={focused ? 'true' : undefined}
                >
                  {i + 1}. {label}
                </li>
              );
            })}
          </ol>
        </div>
      </Frame>

      {published && route ? (
        <Frame>
          <div className="mb-2 flex items-center gap-2">
            <Badge tone="warning">Published render</Badge>
            <span className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
              Live page — unpublished edits aren’t shown until you release.
            </span>
            <a
              href={route}
              target="_blank"
              rel="noreferrer"
              className="adm-focusable ml-auto inline-flex items-center gap-1 text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-accent)]"
            >
              Open <IconExternalLink size={13} />
            </a>
          </div>
          <iframe
            title={`Live preview of ${route}`}
            src={route}
            className="h-[28rem] w-full rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-white"
          />
        </Frame>
      ) : (
        <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
          Not published yet — the structured view above reflects the working copy. Draft SSR preview is out of scope
          (the canvas has the same limitation).
        </p>
      )}
    </div>
  );
}

function SectionPreview({ record }: { record: Rec }) {
  const body = asBag(record.body);
  const section = asBag(body.section);
  const data = asBag(section.data);
  return (
    <Frame>
      <KeyRows
        rows={[
          ['Type', str(section.type)],
          ['Heading', str(section.heading) ?? str(data.heading)],
          ['Eyebrow', str(data.eyebrow)],
          ['Id', str(section.id)],
        ]}
      />
    </Frame>
  );
}

function ThemePreview({ record }: { record: Rec }) {
  const tokens = asBag(record.body).tokens;
  const swatches = tokenSwatches(tokens);
  const fonts = tokenFonts(tokens);
  return (
    <div className="flex flex-col gap-4">
      <Frame>
        <p className="mb-2 text-[length:var(--adm-text-xs)] font-medium uppercase tracking-wide text-[var(--adm-text-muted)]">
          Palette
        </p>
        {swatches.length ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {swatches.map((s) => (
              <div key={s.name} className="flex items-center gap-2">
                <span
                  className="h-8 w-8 shrink-0 rounded-[var(--adm-radius-md)] border border-[var(--adm-border)]"
                  style={{ background: s.value }}
                />
                <span className="min-w-0">
                  <span className="block truncate text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-text)]">
                    {s.name}
                  </span>
                  <span className="block truncate text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                    {s.value}
                  </span>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">No color tokens.</p>
        )}
      </Frame>
      {fonts.length ? (
        <Frame>
          <p className="mb-2 text-[length:var(--adm-text-xs)] font-medium uppercase tracking-wide text-[var(--adm-text-muted)]">
            Typography
          </p>
          <ul className="flex flex-col gap-2">
            {fonts.map((f) => (
              <li key={f.name}>
                <span className="text-[length:var(--adm-text-xs)] uppercase tracking-wide text-[var(--adm-text-muted)]">
                  {f.name}
                </span>
                <p className="text-[length:var(--adm-text-lg)] text-[var(--adm-text)]" style={{ fontFamily: f.value }}>
                  The quick brown fox jumps over the lazy dog
                </p>
              </li>
            ))}
          </ul>
        </Frame>
      ) : null}
    </div>
  );
}

function ProductPreview({ record }: { record: Rec }) {
  const p = productPreview(record);
  return (
    <Frame>
      <div className="mx-auto max-w-sm rounded-[var(--adm-radius-lg)] border border-[var(--adm-border)] bg-[var(--adm-surface)] p-4 shadow-[var(--adm-shadow-sm)]">
        {p.image ? (
          <img src={p.image.src} alt={p.image.alt ?? ''} className="mb-3 w-full rounded-[var(--adm-radius-md)]" />
        ) : null}
        <h3 className="text-[length:var(--adm-text-lg)] font-semibold text-[var(--adm-text-heading)]">{p.title}</h3>
        {p.excerpt ? (
          <p className="mt-1 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">{p.excerpt}</p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {p.priceLabel ? <Badge tone="accent">{p.priceLabel}</Badge> : null}
          {p.mode ? <Badge tone="neutral">{p.mode}</Badge> : null}
          {p.gate ? <Badge tone="warning">{p.gate}</Badge> : null}
        </div>
      </div>
    </Frame>
  );
}

function NavItemTree({ items, depth = 0 }: { items: unknown[]; depth?: number }) {
  return (
    <ul className={depth ? 'ml-4 border-l border-[var(--adm-border)] pl-3' : ''}>
      {items.map((raw, i) => {
        const item = asBag(raw);
        const label = str(item.label) ?? str(item.id) ?? `Item ${i + 1}`;
        const target = asBag(item.target);
        const kind = str(target.kind) ?? str(item.kind);
        const children = Array.isArray(item.children) ? item.children : [];
        return (
          <li key={i} className="py-1">
            <span className="text-[length:var(--adm-text-sm)] text-[var(--adm-text)]">{label}</span>
            {kind ? (
              <span className="ml-2 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                ({navigationTargetLabel(kind)})
              </span>
            ) : null}
            {children.length ? <NavItemTree items={children} depth={depth + 1} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

function NavigationPreview({ record }: { record: Rec }) {
  const body = asBag(record.body);
  const items = Array.isArray(body.items) ? body.items : [];
  return (
    <Frame>
      <KeyRows
        rows={[
          ['Role', str(body.role)],
          ['Brand', str(asBag(body.brand).text)],
        ]}
      />
      <div className="mt-3">{items.length ? <NavItemTree items={items} /> : <p>—</p>}</div>
    </Frame>
  );
}

function TaxonomyPreview({ record }: { record: Rec }) {
  const kinds = asBag(asBag(record.body).kinds);
  return (
    <Frame>
      <div className="flex flex-col gap-4">
        {Object.entries(kinds).map(([kind, group]) => {
          const terms = Array.isArray(asBag(group).terms) ? (asBag(group).terms as unknown[]) : [];
          return (
            <div key={kind}>
              <p className="mb-1 text-[length:var(--adm-text-xs)] font-medium uppercase tracking-wide text-[var(--adm-text-muted)]">
                {kind} ({terms.length})
              </p>
              <div className="flex flex-wrap gap-1.5">
                {terms.map((raw, i) => {
                  const term = asBag(raw);
                  return (
                    <Badge key={i} tone={str(term.status) === 'deprecated' ? 'neutral' : 'info'}>
                      {str(term.label) ?? str(term.slug) ?? `term ${i}`}
                    </Badge>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </Frame>
  );
}

function SitePreview({ record }: { record: Rec }) {
  const body = asBag(record.body);
  const urls = asBag(body.urls);
  return (
    <div className="flex flex-col gap-4">
      <Frame>
        <KeyRows
          rows={[
            ['Name', str(body.name)],
            ['Brand', str(asBag(body.brand).text)],
            ['Base URL', str(urls.base)],
            ['Canonical host', str(urls.canonicalHost)],
          ]}
        />
      </Frame>
      {tokenSwatches(body.brandTokens).length ? (
        <ThemePreview record={{ ...record, body: { tokens: body.brandTokens } }} />
      ) : null}
    </div>
  );
}

function RecipePreview({ record }: { record: Rec }) {
  const body = asBag(record.body);
  const slots = Array.isArray(body.slots) ? body.slots : [];
  const blueprint = asBag(body.blueprint);
  return (
    <Frame>
      <KeyRows
        rows={[
          ['Name', str(body.name)],
          ['Scope', str(body.scope)],
          ['Description', str(body.description)],
          ['When to use', str(body.whenToUse)],
          ['Blueprint type', str(blueprint.type)],
          ['Applies to', Array.isArray(body.appliesTo) ? (body.appliesTo as string[]).join(', ') : undefined],
          ['Slots', slots.length ? String(slots.length) : undefined],
        ]}
      />
    </Frame>
  );
}

export function ObjectPreview({ record, focusId }: { record: Rec; focusId?: string }) {
  switch (record.object_type) {
    case 'content_item':
      return <ContentItemPreview record={record} />;
    case 'page':
      return <PagePreview record={record} focusId={focusId} />;
    case 'section':
      return <SectionPreview record={record} />;
    case 'theme':
      return <ThemePreview record={record} />;
    case 'product':
      return <ProductPreview record={record} />;
    case 'navigation':
      return <NavigationPreview record={record} />;
    case 'taxonomy':
      return <TaxonomyPreview record={record} />;
    case 'site':
      return <SitePreview record={record} />;
    case 'template':
    case 'section_template':
      return <RecipePreview record={record} />;
    default:
      return (
        <Frame>
          <EmptyState
            icon={<IconInfo size={24} />}
            title={`No preview for ${objectTypeLabel(record.object_type)}`}
            message="This object type doesn’t have a visual preview yet."
          />
        </Frame>
      );
  }
}

export default ObjectPreview;
