# New-client acceptance — the genesis spine

**T16.10.** One ordered checklist to birth a client, stage 0 → stage 1 →
verification, each step naming its command, its proof, and who does it
(agent vs. account authority). This is the spine, not the manual: detail
tables (the full per-site env list, the admin-workspace human-gate
click-by-click, storage-grant provisioning) live in
[`site-provisioning-runbook.md`](./site-provisioning-runbook.md) and
[`cms-pipeline/T11.7-provisioning-cli.md`](./cms-pipeline/T11.7-provisioning-cli.md)
— follow the links at the point each step needs them, don't read those first.
The stage boundaries below are LAW, defined in
[`16-genesis-parity-plan.md` §2](./16-genesis-parity-plan.md#2-the-genesis-line-law).

`npm run <script> -- <args>` passes args through to the underlying script —
the `--` is required or npm swallows them.

---

## Stage 0 — Scaffold (repo files, owner: `create-site`)

1. **Plan the scaffold.**
   `npm run site:create -- --name <client> --dry-run`
   *Proof:* prints the full file list + env checklist; touches no disk, no
   network.
   *Authority:* agent.

2. **Write the scaffold.**
   `npm run site:create -- --name <client>`
   *Proof:* `sites/<client>/` exists (config bundle, netlify.toml, empty
   export tree, baseline seed pack). Idempotent — safe to re-run.
   *Authority:* agent. Then rebrand `config/site-identity.ts` and
   `seeds/site-seed-data.mjs` per runbook §1 before continuing.

3. **Provision the Netlify project + stores + auto-secrets.**
   `npm run site:create -- --name <client> --netlify-token $NETLIFY_API_TOKEN`
   *Proof:* the printed checklist's generated-secret rows flip to ✓; the
   blob-store probe (write → read → delete on every store) passes.
   *Authority:* agent, using a token only an account holder can mint.

4. **By-hand env + console steps.** GitHub repo binding, build hook, Netlify
   Identity, `ADMIN_EMAILS`, first-Owner invite, DNS — the full list and
   exact clicks are runbook [§3](./site-provisioning-runbook.md#3-whats-still-yours-to-do-by-hand)
   and §3a (the admin-workspace human gate, same file).
   *Proof:* none yet — proven by step 5.
   *Authority:* human (account authority — Netlify/GitHub console, secret
   custody).

5. **Verify stage 0 + admin parity.**
   `npm run fleet:parity`
   *Proof:* `RESULT: PASS` — no GAP rows for any site, including the new one
   (`--all` discovers every `sites/<slug>` with a `netlify.toml`, so the new
   client is picked up automatically). HUMAN rows are expected to list (they
   name what step 4 covers, not what's missing); a PASS means the repo half
   is provably complete and the human half is fully enumerated.
   *Authority:* agent.

---

## Stage 1 — Genesis (store birth, owner: `site-genesis-drive`)

6. **Plan the drive.**
   `npm run site:genesis -- --site sites/<client> --endpoint https://<host>/mcp --dry-run`
   *Proof:* prints the full object plan in dependency order (navigation →
   site singleton → taxonomy → theme → recipes → templates → bootstrap
   pages); no network call.
   *Authority:* agent.

7. **Run the drive.**
   `MCP_HTTP_AUTH_TOKEN=… npm run site:genesis -- --site sites/<client> --endpoint https://<host>/mcp`
   *Proof:* every planned object created → published → checked in, one
   `release_to_production` at the end. Idempotent — re-running after a
   partial failure only does what's left.
   *Authority:* agent, using the site's own `MCP_HTTP_AUTH_TOKEN` (set in
   step 3).

8. **Verify genesis landed.**
   `MCP_HTTP_AUTH_TOKEN=… npm run site:verify -- --site sites/<client> --endpoint https://<host>/mcp`
   *Proof:* every stage-1 manifest entry reports `OK` (not `MISSING` or
   `DRIFTED`), and every bootstrap page export has been replaced by a real
   materialized one. Read-only — creates, patches, publishes nothing.
   *Authority:* agent.

---

## Verification — live truth (law P3)

9. **Fleet capability probe.**
   `MCP_HTTP_AUTH_TOKEN__<SLUG>=… npm run fleet:capability`
   probes every site in the script's committed fleet map; for a client not
   yet added to that map, probe it directly instead:
   `MCP_HTTP_AUTH_TOKEN__<SLUG>=… node scripts/fleet-capability-probe.mjs --site <slug> --endpoint https://<host>/mcp`.
   *Proof:* the new tenant answers `capability_status` cleanly and the cheap
   real-tool reads it exercises don't 503 — the check that catches a tool
   that *lists* in `tools/list` but fails at call time, which repo parity
   (steps 1–8) cannot see. This is the last gate: a client isn't accepted on
   file parity alone, only on a live probe going green.
   *Authority:* agent.

A client that clears steps 1–9 is **genesis-complete**: every governed
object type is exercisable via its own `/mcp`, and the site renders entirely
from store-backed objects. Nothing below this line is genesis's job.

---

## Stage 2 — Onboarding (explicitly OUT of genesis scope)

`create-site` emits skeleton seed files for these so the shape is
fleet-uniform, but genesis never invents their content. Handing a new client
its identity is separate work, done by humans/agents afterward:

- **Editorial voice** — the client's real `editorial_voice` content.
- **Tracking configuration** — real `tracking_config` (project id, sink,
  salt beyond the provisioned defaults).
- **Branding beyond the default theme** — a client-specific palette/theme
  applied via `site_apply_theme`, not the scaffold's starter theme.
- **Products** — real `product` instances, if this client sells.

Stage 3 (articles, pages, sections — ongoing content) is further out still
and was never genesis's business.
