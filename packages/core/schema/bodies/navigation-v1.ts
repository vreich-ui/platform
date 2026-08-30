/**
 * Navigation body schema — 'navigation.v1' (D§3.8).
 *
 * Also hosts the shared link primitives (`RichText`, `NavTarget`, `LinkAction`)
 * because the docs define them across §3.5/§3.8 as one vocabulary: `LinkAction`
 * wraps a `NavTarget`, and `NavigationBody` uses `LinkAction`/`RichText`.
 * Placing all three here (the section owning `NavTarget`) keeps the body
 * modules acyclic: section-v1 imports from this file, never the reverse.
 *
 * Committed amendments baked in (C§1.2–1.3, recorded in the D§3.8 Δ note):
 *   M-1  NavItem.description
 *   M-2  groups[].slot ('primary' | 'secondary' | 'social')
 *   M-5  groups[].target — stored but NOT rendered as a link today
 *        (Header.astro renders dropdown parents as buttons); preserving the
 *        data, not a live behavior. Do not wire it to anything.
 *   M-7  NavItem.icon / NavItem.ariaLabel
 *
 * Transitional variant (04-phased-plan Gap Note 2): `NavTarget` includes
 * `{kind: 'route', href}` — a deliberate lifecycle member (introduced P0,
 * consumed P2/P3, upgraded P3/P4, removed P6), legal anywhere a NavTarget
 * appears. It is NOT a placeholder to "fix" into `page`-kind before the
 * referenced Page object exists.
 *
 * Structural safety checks beyond shape (targets resolve, no empty groups,
 * depth ≤ 2, duplicate-target warnings — C§2.3-Navigation) are the validation
 * pipeline's job (T0.7), not this schema's.
 */
import { z } from 'zod';
import { trackingAttributeShape } from './tracking-attribute-v1.js';

export const NAVIGATION_SCHEMA_VERSION = 'navigation.v1';

// TipTap-produced HTML constrained to the existing sanitizer allowlist
// (p, br, strong, em, a, ul, ol, li, h2, h3 — D§3.5 / A§1.5). Sanitization is
// enforced at write/validation time, not by this shape.
export const richTextSchema = z.string();
export type RichText = z.infer<typeof richTextSchema>;

export const navTargetSchema = z.discriminatedUnion('kind', [
  // Resolved to the page's route at materialize time (D§3.8).
  z.object({ kind: z.literal('page'), page: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('taxonomy'),
      termKind: z.enum(['category', 'tag']),
      term_id: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal('listing'), list: z.literal('content_index') }).strict(),
  z.object({ kind: z.literal('external'), href: z.string().min(1) }).strict(),
  // e.g. /rss.xml (A§2.3).
  z.object({ kind: z.literal('asset'), href: z.string().min(1) }).strict(),
  // Transitional (Gap Note 2): site-relative route for targets whose Page
  // object doesn't exist yet. Removed from the validators in P6 cleanup.
  z.object({ kind: z.literal('route'), href: z.string().min(1) }).strict(),
]);
export type NavTarget = z.infer<typeof navTargetSchema>;

export const linkActionSchema = z
  .object({
    label: z.string().min(1),
    target: navTargetSchema,
    style: z.enum(['primary', 'secondary', 'link']).optional(),
  })
  .strict();
export type LinkAction = z.infer<typeof linkActionSchema>;

export type NavItem = {
  id: string;
  label: string;
  description?: string;
  target: NavTarget;
  children?: NavItem[];
  icon?: string;
  ariaLabel?: string;
  adminOnly?: boolean;
};

export const navItemSchema: z.ZodType<NavItem> = z.lazy(() =>
  z
    .object({
      id: z.string().min(1), // opaque, stable
      label: z.string().min(1),
      description: z.string().optional(), // M-1: every header dropdown item carries one
      target: navTargetSchema,
      children: z.array(navItemSchema).optional(), // dropdown groups (A§2.2); depth cap is T0.7
      icon: z.string().optional(), // M-7: icon-set name (e.g. 'tabler:rss')
      ariaLabel: z.string().optional(), // M-7: social links carry both today (navigation.ts:104)
      // M-9 (2026-07-14): item is revealed client-side only when the visitor is
      // a signed-in admin (rendered with `data-admin-only hidden` — inside the
      // account menu, HeaderAuthButton.astro, since the admin-menu-reorganize
      // change moved it out of the main nav; the header-auth script toggles it
      // on the admin-auth-state check). Data only — NOT a security boundary;
      // admin routes enforce auth server-side.
      adminOnly: z.boolean().optional(),
    })
    .strict()
);

export const navGroupSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().optional(),
    slot: z.enum(['primary', 'secondary', 'social']).optional(), // M-2: footer row placement
    target: navTargetSchema.optional(), // M-5: stored, deliberately unrendered (C§1.2)
    items: z.array(navItemSchema),
    // M-9 (2026-07-14): the whole group (a top-level header dropdown) is
    // admin-only — same client-reveal contract as NavItem.adminOnly.
    adminOnly: z.boolean().optional(),
  })
  .strict();
export type NavGroup = z.infer<typeof navGroupSchema>;

export const navigationBodySchema = z
  .object({
    // W13: shared tracking attribute (12-plan §2) — set_tracking is its one writer.
    ...trackingAttributeShape,
    role: z.enum(['header', 'footer', 'secondary', 'social']),
    brand: z
      .object({
        text: z.string().optional(),
        descriptor: z.string().optional(),
      })
      .strict()
      .optional(), // Footer.astro brand/descriptor props (A§2.3)
    groups: z.array(navGroupSchema),
    actions: z.array(linkActionSchema).optional(), // header CTA(s) (A§2.2)
    footNote: richTextSchema.optional(), // Footer footNote (A§2.3)
  })
  .strict();
export type NavigationBody = z.infer<typeof navigationBodySchema>;
