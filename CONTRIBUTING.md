# Contributing to Klyth

This page explains how to develop Klyth. The [README](README.md) explains how to use it.
[docs/CONFIG.md](docs/CONFIG.md) lists every config key.

## Prerequisites

- Claude Code and Bun at the versions in the README's [What you need](README.md#what-you-need).
- Run `bun install` once to get the dev dependencies (`typescript`, `@types/bun`).

## The dev loop

Install the mod from your checkout, as in step 1 of the README's [Quickstart](README.md#quickstart). Claude Code loads
Klyth from that folder through the local marketplace. An edit applies in the next session, or when you run
`/reload-plugins`. After an edit to `klyth.json` alone, `/klyth reload` is enough.

## The gates

Run all of these before you send a change:

```sh
claude plugin validate .
claude plugin test .
bun run typecheck          # tsc for the mod, then for klythd and the scripts
bun run test:harness
bun run test:klythd
bun run check:test-data
bun run check:schemas
```

CI runs `check:test-data`, `test:klythd` and `test:harness` on macOS and Linux. The other gates run only on your
machine. They need the Claude Code CLI and the types that Claude Code writes beside the installed mod.

`claude plugin test` does not run `tests/harness`. Run `bun run test:harness` yourself.

The stamp in `hooks/schemas.gen.ts` names the Claude Code version that generated the schemas. A newer Claude Code does
not make older schemas current. Report the Claude Code version and the stamp version separately. Never relabel a
generated stamp.

## Regenerating files

- After a Claude Code upgrade, run `bun scripts/gen-schemas.ts`. It regenerates `hooks/schemas.gen.ts` from the types
  that Claude Code writes beside the mod. When MCP declarations are there, it also regenerates the git-ignored
  `hooks/schemas.mcp.gen.json`. `/klyth` says when the stamp is stale.
- After you edit `example.klyth.json` or a recorded stream in `tests/fixtures/sse`, run `bun scripts/gen-test-data.ts`.
  It regenerates `tests/fixtures/data.gen.ts`, because `claude plugin test` gives test files no filesystem.
  `bun run check:test-data` fails when that file is stale.

## The smoke script

`bun scripts/klythd-smoke.ts <alias>` starts klythd and sends one real step to the provider of that alias. It runs the
provider's key command and sends a short prompt, so run it on purpose. The header of the script explains its options
(`--tool-loop`, `--effort <level>` and `--pad <n>`) and its output.

`CLAUDE_CONFIG_DIR` picks the config, so you can point the script at a scratch directory. It does not isolate the OS
keyring or the home-scoped OAuth refresh locks. A real helper can still access real credentials.

## Code rules

- Only `hooks/register.ts` touches the engine's `$` object. Other modules work through ports that it passes in.
- A routed step supplies its own response. It never falls back to native inference after a failure.
  [How does it work?](README.md#how-does-it-work) explains the hook.
- `hooks/product.ts` holds the product identity and the pure path builders. It must work in the host sandbox, with no
  filesystem or Node dependency. Keep credential namespace values separate from display branding.
- Put configurable provider differences in config and protocol handling in codecs. Keep each provider-specific
  exception narrow, and cover it with a test.
- Keep raw classifier review payloads ephemeral. Never put them in plugin state or logs.
- Do not add prompts, response text, credentials, URLs or tool inputs to usage state. Usage observers must not wait
  for host state or store I/O on the inference path. Pricing stays in model metadata, not in codec request params.
- `klythd/budget.spec.ts` sets the line limits. A `hooks/` module has at most 400 lines, with larger limits for
  `hooks/register.ts` and `hooks/classifier-rules.ts`. Daemon production code has one total limit. A higher limit needs
  a concrete reason.

## Tests

- Every behavior fix ships with a test that fails before the fix and passes after it.
- `claude plugin test` runs the `*.test.ts` files in `tests`. `bun run test:klythd` runs the specs in `klythd` and `private/`, where present.
  `bun run test:harness` runs the scripts in `tests/harness`.
- Use synthetic credentials and offline fixtures. No secret goes in a test or a fixture. Do not call the production
  auth CLI, a real keyring or a real provider. Loopback HTTP fixtures are fine.
- Credential migration tests inject ports and synthetic records, keyed by namespace and provider. They cover
  conflicts, read errors, no-clobber creation races, exact readback, source changes before retirement, lock release
  and order, and host-identity handling.
- Changing only `CLAUDE_CONFIG_DIR` does not isolate home-scoped refresh locks.
- Tests assert the literal plugin owners, the hook matchers and the production defaults independently.

## Clean room

Klyth reads nothing from the Claude Code binary. The README's [Credits and license](README.md#credits-and-license)
section states the rule. Follow these points:

- Klyth writes each prompt and tool text that it adds.
- The input schemas of Claude Code's tools come from `bun scripts/gen-schemas.ts` alone.
- To recognize a line that Claude Code writes, the code matches the words that identify the line. A fixture quotes no
  more of the line than the matcher needs (`tests/fixtures/handback.ts`).

## Docs and commits

- Change the docs in the same pull request as the behavior. Make sure that examples, plugin names and local links
  match.
- Remove secrets and private paths from any log or config excerpt that you share.
- Commit messages follow Conventional Commits. Start each message with a type, such as `fix:`, `feat:` or `docs:`.
