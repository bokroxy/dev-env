# Below-prompt todo presentation

Presentation-only adapter for the installed `@juicesharp/rpiv-todo` package.

- Todos mount **below** the prompt/editor, with a separated heading rule, one blank row above/below, and a two-column horizontal inset.
- Original todo tools, commands, task/session replay, collapse shortcut, row budget and completed-task handling are reused.
- The upstream factory's overlay-importer argument supplies a subclass that only adapts `setUICtx()`. No npm source is patched and no task data is migrated.
- Other widget keys and native UI methods/getters remain untouched.
- `settings.json` retains the npm package but disables its default extension resource (`extensions: []`), preventing duplicate todo registrations. The local `index.ts` auto-loads instead.
- If the upstream importer seam changes during an update, recheck this adapter. To revert, remove/disable this local extension and restore the npm package's normal extension resource.

Run `/reload` to activate.

Validation: `npm run check`, `npm test`, `npm run format`, `npm run lint`. Local render/lifecycle fixtures do not call any model.
`optional-i18n.d.ts` only describes the upstream package's optional SDK types; it does not install or enable localization.

Full workflow diagnostics remain in `/workflows` and run artifacts. Normal chat workflow bars intentionally keep only outcome, coloured progress and phase counts.
