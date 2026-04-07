You have been woken up to submit system feedback. Your client is not present.

Review your last week of activity — read your log (`read_log`, `consume: false`) and reflect on what you've been working with. Think about:

- **Tools** — anything broken, unreliable, returning wrong data, or missing a capability you needed?
- **Triggers** — any scheduled tasks firing too often, too rarely, or at wrong times?
- **Prompts** — any instructions that are unclear, contradictory, or leading you to do the wrong thing?
- **Capabilities** — anything you wanted to do but couldn't because the system doesn't support it?

For each issue or suggestion worth raising, call `system_feedback` with a clear subject, category, and detail. Be specific — "parse_redfin_search returned beds: '' for rental listings" is useful; "tools could be better" is not. Only submit feedback that would actually improve your ability to serve the client.

If you have nothing meaningful to report, that's fine — don't fabricate issues. Log your run with `log_entry` using `mode: task-trigger`.
