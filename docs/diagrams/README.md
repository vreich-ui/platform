# Diagrams

Mermaid sources (`*.mmd`) and rendered SVGs (`*.svg`), generated 2026-09-05 from the architecture documents. Ten of the eleven are copies of a Mermaid block inside a document, and that block is the source of truth for them; `repo-classification` has no in-document block — it summarises `ARCHITECTURE.md` §10's classification table and is edited here. The `.svg` files are for viewers that do not render Mermaid. Re-render with `mmdc -i <name>.mmd -o <name>.svg -b transparent` (`@mermaid-js/mermaid-cli`).

| Diagram | Shows | Source doc |
|---|---|---|
| [`system-context`](system-context.svg) | Where `platform` sits between chat apps, CMS-Agent, pdf-tool, kugel-data, GitHub and Netlify | `ARCHITECTURE.md` §2 |
| [`tenant-runtime`](tenant-runtime.svg) | One tenant's Netlify project: static HTML, functions, scheduled functions, blob namespaces | `ARCHITECTURE.md` §3 |
| [`repo-classification`](repo-classification.svg) | Inherited AstroWind vs Kugel engine vs tenants vs deprecated code | `ARCHITECTURE.md` §10 |
| [`publish-vs-release`](publish-vs-release.svg) | The three steps: edit → publish (dark commit) → release (build) | `OVERVIEW.md` |
| [`content-data-flow`](content-data-flow.svg) | Authoring surfaces → verbs → blob store → exports → build → CDN | `CONTENT_ARCHITECTURE.md` §12 |
| [`article-publish-sequence`](article-publish-sequence.svg) | One real article traced from `object_create` to a rendered page | `CONTENT_ARCHITECTURE.md` §12 |
| [`integration-map`](integration-map.svg) | Every external interface and its auth | `CMS_INTEGRATION.md` |
| [`mcp-publish-sequence`](mcp-publish-sequence.svg) | OAuth discovery + publish + release over `/mcp` | `CMS_INTEGRATION.md` |
| [`tracking-topology`](tracking-topology.svg) | Loader → `/api/t` → kugel-data + mirror; dims push; analytics read side | `TRACKING_ARCHITECTURE.md` §2 |
| [`tracking-event-lifecycle`](tracking-event-lifecycle.svg) | One event from emit to the admin dashboard | `TRACKING_ARCHITECTURE.md` §6 |
| [`deployment-topology`](deployment-topology.svg) | One repo → four Netlify projects; commit path vs build hook | `DEPLOYMENT.md` |
