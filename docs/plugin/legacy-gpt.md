# W0.3 — Legacy ChatGPT Custom GPT dump

**Status: BLOCKED — awaiting paste from Wolf.**

Per the execution plan §4 W0.3 and §6, this file is filled by pasting the existing Dr. Lurie Custom
GPT's configuration into the runner chat. It is the seed for `skill.md` (W1.2) and for the GPT
instructions export (W3.2).

Needed:

1. **Instructions** — the full Custom GPT instruction text, verbatim.
2. **Actions schema** — the OpenAPI JSON currently attached to the GPT.
3. **Auth config** — which bridge/proxy sits in front of the tenant, and how it authenticates
   (the plan calls this "the legacy bridge", retired in W3.4).
4. **Knowledge files** — names and, if short, contents.
5. **Conversation starters**, if any.

Until this lands, W1.2's `skill.md` renderer has no seed for the voice/method sections and W3.2 has
nothing to diff the new export against.
