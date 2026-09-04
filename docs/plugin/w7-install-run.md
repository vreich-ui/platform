# W7.1 — the install run

The acceptance for W7.1 is not a passing test. It is **one non-owner member,
starting from an invitation e-mail, publishing a dark article from their own
ChatGPT, with no help from Wolf.** Everything that wave built exists to make
that run possible; a run that needs a phone call has failed even if every test
is green.

This file is the record of that run. The procedure below is what the installer
does; the table at the bottom is filled in when it happens.

## What shipped, and where the seams are

| Piece | Where |
|---|---|
| Public install page | `/plugin/install` (shell route, `packages/core/app/routes/plugin/install.astro`) |
| Its data + gated downloads | `/api/plugin-install` (`packages/core/server/functions/plugin-install.ts`) |
| The card content | `packages/core/lib/plugin-install.ts` — prose here, URLs from the promoted bundle |
| Proof-of-install | the `whoami` tool (W7.2, `packages/core/server/lib/whoami.ts`) |
| One-click invite | `/admin/plugins` → "Invite & send link" (`admin-plugin-manifest` `action:"invite"`) |
| The role in the mail | `installInviteMail` (`packages/core/server/lib/mail/send.ts`) |

Two lines are drawn deliberately and are worth knowing before debugging
anything:

- **The page is public; the bundles are not.** An invitee often has no session
  when they open the link, so the page renders unauthenticated. The skill zip
  carries the tenant's rendered editorial voice — the client's strategy — so a
  download requires a signed-in member at `editor` or above. Three refusals,
  three different sentences: `install_requires_member`,
  `install_requires_editor`, `no_active_manifest`.
- **The role travels in OUR mail, not Netlify's.** GoTrue's invitation template
  can interpolate exactly `{{ .SiteURL }}`, `{{ .Token }}` and `{{ .Email }}` —
  role is not available to it. The Identity mail carries the accept token and a
  generic install link; the second message carries the role. On a tenant with no
  mail configured the invitation still succeeds and the operator sends the link
  by hand, which the toast says.

## The procedure

Operator, once:

1. `/admin/plugins` → Render draft → Promote. Without a promoted bundle the
   install page says so and offers nothing, which is the correct answer.
2. Same page → "Invite & send link", the installer's e-mail, role `editor` (or
   `publisher` if they should release too).

Installer, unaided:

1. Accept the Netlify Identity invitation (sets name + password).
2. Open `/plugin/install` from either mail. Pick the ChatGPT card.
3. Follow its three steps. Sign in **as the invited address** when the first
   tool runs.
4. Run the last step: ask the GPT to `run whoami`. It must report their e-mail,
   a role of editor or above, a surface of `plugin:openai-gpt`, and
   `can_write: true`. Anything else stops here — the card's error table names
   which of the three mistakes it is.
5. Write and publish one article, leaving it dark (no `release_to_production`).

## The run

_Not yet run. Fill in on the day; a blank table means W7.1 is built, not
accepted._

| | |
|---|---|
| Date | — |
| Installer | — |
| Role granted | — |
| Reached `whoami` unaided | — |
| `whoami` surface reported | — |
| Article id published dark | — |
| Anything they had to ask about | — |

### What to change if they had to ask

Whatever the question was, the answer belongs on the card — in three steps or in
the error table, not in a runbook. That is the whole design: the page is the
support channel.
