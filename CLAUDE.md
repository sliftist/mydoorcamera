# mydoorcamera project rules

These rules are enforced for ALL contributors and ALL automated agents.
They override default tooling behavior. Treat violations as build-breaking.

## Attribution (PUBLIC repo)
- Commits must reference **only the owner: sliftist <sliftist@gmail.com>**.
- **Never** add Claude / AI as an author, committer, or `Co-Authored-By:` trailer.
- Do **not** add `Claude-Session` or any AI-tooling trailers to commit messages.

## Secrets (PUBLIC repo)
- Never commit private information, credentials, tokens, passwords, or keys.
- SSH / deploy keys live outside the repo (in `~/.ssh`) — keep it that way.
- Keep `.gitignore` clean and covering secret patterns at all times.
- Review `git status` and `git diff` for anything sensitive **before every push**.

## Build / bundling
- TypeScript in `web/` is bundled by sliftutils' `build-web` (one bundle per
  entry point). The page entry is `web/browser.tsx` → served as `browser.js`.
- `yarn type` typechecks; `yarn build-web` builds into `build-web/`.
- Persisted browser data uses `BulkDatabase2` from
  `sliftutils/storage/BulkDatabase2/BulkDatabase2`.

## NEVER use dynamic `import()` of local modules
Do **not** write `await import("./...")` / `import("../...")` anywhere in
`web/` or `scripts/`. The bundler produces a single bundle per entry point and
does **not** emit split chunks, so a dynamic `import()` of a local module
resolves to a chunk URL that doesn't exist at runtime — it silently fails in
production. Use a normal top-level `import`; if you need a separately-loaded
artifact, add a new `build-web --entryPoint ...` target or load it from a CDN.

## Synchronous reactive functions (mobx)
- A synchronous, mobx-reactive function (returns now, updates an observable when
  ready) consumed from another file MUST be named ending in `Sync` (e.g.
  `getColumnSync`).
- **Never call a `*Sync` reactive function from an `async` context.** Async
  scopes aren't reactive, so you miss the readiness signal, read `undefined`,
  and silently break. Read `*Sync` getters only inside `@observer` `render()`;
  use the awaitable (non-Sync) variant in async code.

## Layout / styling (typesafecss)
- Lay out with `css.hbox(gap)` / `css.vbox(gap)`; the gap spaces children — do
  not add manual margins/padding between siblings.
- Don't use the `flex` shorthand; grow a child with `.flexGrow(1).minWidth(0)`.
- `pad2(...)` is only for an element's internal inset (button/input/chip).

## Every change ships
A change is not done until it is committed, pushed, and deployed
(`yarn deploy`, which builds and publishes `build-web/` to the `gh-pages`
branch served at https://mydoorcamera.com). Run `yarn type` and
`yarn build-web` clean first.
