/**
 * IDENTITY E-MAIL TEMPLATES → `/emails/identity/*.html` (W18 T18.0c).
 *
 * Netlify Identity's custom e-mail templates are plain files served from the
 * site's publish directory; their PATH is set per site in the console
 * (Project configuration → Identity → Emails). The templates are fleet law —
 * every one of them links to `/admin/accept/#<token>=…`, the page T18.0b built
 * to consume the four GoTrue tokens — so they live once, in core
 * (`packages/core/app/emails/identity/`), and this integration copies them
 * into every tenant's build output. Nothing is copied into
 * `sites/<client>/public/`: a per-site copy would drift the first time the
 * accept flow changed (P1 by construction, not by discipline).
 *
 * A build-done hook rather than an Astro endpoint route for the same reason as
 * `site-redirects-integration.ts`: `build.format` is `directory`, so a route
 * at `/emails/identity/invitation.html` would land as
 * `…/invitation.html/index.html` and the console path would 404.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';

/** Core source of the four templates. */
export const IDENTITY_EMAIL_TEMPLATES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'emails',
  'identity'
);

/** Publish-dir path (and therefore URL path) the templates are served from. */
export const IDENTITY_EMAIL_TEMPLATES_PUBLIC_DIR = 'emails/identity';

/**
 * The four templates, keyed by the console field they belong to. `hashKey` is
 * the GoTrue mail token each one carries into `/admin/accept`.
 */
export const IDENTITY_EMAIL_TEMPLATES: ReadonlyArray<{ console: string; file: string; hashKey: string }> = [
  { console: 'Invitation', file: 'invitation.html', hashKey: 'invite_token' },
  { console: 'Confirmation', file: 'confirmation.html', hashKey: 'confirmation_token' },
  { console: 'Recovery', file: 'recovery.html', hashKey: 'recovery_token' },
  { console: 'Email change', file: 'email-change.html', hashKey: 'email_change_token' },
];

/** The per-site console value for each template ("Emails → <console> → path"). */
export const identityEmailTemplatePath = (file: string): string => `/${IDENTITY_EMAIL_TEMPLATES_PUBLIC_DIR}/${file}`;

export const identityEmailTemplates = (): AstroIntegration => ({
  name: 'platform-identity-email-templates',
  hooks: {
    'astro:build:done': ({ dir, logger }) => {
      const outDir = path.join(fileURLToPath(dir), IDENTITY_EMAIL_TEMPLATES_PUBLIC_DIR);
      fs.mkdirSync(outDir, { recursive: true });
      let copied = 0;
      for (const template of IDENTITY_EMAIL_TEMPLATES) {
        const source = path.join(IDENTITY_EMAIL_TEMPLATES_DIR, template.file);
        if (!fs.existsSync(source)) {
          logger.warn(`identity e-mail template missing in core: ${template.file}`);
          continue;
        }
        fs.copyFileSync(source, path.join(outDir, template.file));
        copied += 1;
      }
      logger.info(
        `published ${copied} Netlify Identity e-mail template(s) under /${IDENTITY_EMAIL_TEMPLATES_PUBLIC_DIR}/`
      );
    },
  },
});
