# System diagram sources

One `.mmd` file per Mermaid block in `../*.md` (the Markdown source is authoritative; GitHub renders the blocks inline). Rendered SVGs are not committed — produce them locally when needed:

```
npx -y @mermaid-js/mermaid-cli -i <name>.mmd -o <name>.svg -b transparent
```

| File | Source |
|---|---|
| `01-system-context` | SYSTEM-ARCHITECTURE.md §2 |
| `02-deployment-topology` | SYSTEM-ARCHITECTURE.md §3 |
| `03-authority-boundaries` | SYSTEM-ARCHITECTURE.md §4 |
| `04-agent-workflow` | SYSTEM-ARCHITECTURE.md §5 |
| `05-content-publication` | SYSTEM-DATA-FLOW.md §3 |
| `06-artifact-generation` | SYSTEM-DATA-FLOW.md §4 |
| `07-site-capture` | SYSTEM-DATA-FLOW.md §5 |
| `08-tracking-ingestion` | SYSTEM-DATA-FLOW.md §6 |
| `09-conversion-revenue` | SYSTEM-DATA-FLOW.md §7 |
| `10-publish-gates` | SYSTEM-PUBLISHING.md §2 |
| `11-artifact-transformations` | SYSTEM-ARTIFACTS.md §2 |
| `12-trust-boundaries` | SYSTEM-SECURITY-BOUNDARIES.md §1 |

All diagrams describe the CURRENT system at the pins recorded in each document. There are no FUTURE diagrams: SYSTEM-FUTURE-EXTENSIONS.md deliberately contains only an identifier chain, not a system drawing.
