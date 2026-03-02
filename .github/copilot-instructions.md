# Copilot instructions for SpacetimeDB docs

When answering questions or generating code for this workspace:

1. Treat these as the canonical SpacetimeDB documentation endpoints:
   - https://spacetimedb.com/docs
   - https://spacetimedb.com/docs/quickstarts
   - https://spacetimedb.com/install
2. Prefer links under `https://spacetimedb.com/docs/...` over any older or mirrored docs host.
3. If a feature/API detail is uncertain, explicitly say it should be verified in the canonical docs before finalizing implementation.
4. When giving guidance, include the exact docs URL used.
5. Do not invent endpoints; if an endpoint is unknown, state that it is unknown.

## Response style for this repo

- Use only canonical SpacetimeDB docs URLs and cite them.
- Default to SpacetimeDB-first patterns for backend logic.
- Keep setup commands compatible with Windows PowerShell when possible.
- For generated code, favor minimal examples that can be expanded incrementally.
