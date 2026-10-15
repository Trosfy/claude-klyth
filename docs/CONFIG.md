# Config reference

Klyth reads one file, `klyth.json`, from the configuration directory of Claude Code. That is `$CLAUDE_CONFIG_DIR` when
the variable has a non-empty value, and `~/.claude` otherwise. Klyth also reads the plugin list
(`plugins/installed_plugins.json`) and your agents (`agents/`) there. `/klyth reload` re-reads the file.
[`example.klyth.json`](../example.klyth.json) is the [OpenAI recipe](PROVIDERS.md#openai) and passes validation as
shipped. Other recipes are in [PROVIDERS.md](PROVIDERS.md).

**Validation is all-or-nothing.** Any error turns routing off. One toast names the first error, and `/klyth` lists all
errors with the next step. While the file is broken, `/model <alias>` (for an alias that the file or the last good
config declares) and `/model <provider>/<model>` answer with the error. They never reach the native `/model`. A turn
that Klyth routed before the error gets the error text and goes nowhere else.

## Top-level keys

| Key | Meaning |
| --- | --- |
| `providers` | A map of provider id to [provider](#providers). |
| `aliases` | A map of alias name to [alias](#aliases). |
| `classifier` | Optional. Turns on the [classifier](#classifier), an opt-in stand-in for the verdict of auto mode on routed turns. `{}` takes every default. |
| `statusLine` | Optional. `"pinned"` (default) or `"command"`. With `"command"`, Klyth stops pinning the route under the prompt, where Claude Code draws it behind a ⚠. Klyth records the route for the status line command that Claude Code runs instead. Any other value is the error `statusLine: must be "pinned" or "command"`. [Status line](../README.md#status-line) has the setup. |
| `compaction` | Optional. An object with the keys `hostWindow` and `deliveryRecovery`. See [Compaction](#compaction). |
| `version` | Optional. Must be `1`. |
| `$schema` | Accepted for your editor and ignored. |

Any other key is an error.

## Providers

A provider id starts with a lowercase letter and holds lowercase letters, digits and dashes. It has at most 32
characters. `native` is not allowed.

| Key | Needed | Meaning |
| --- | --- | --- |
| `kind` | yes | `openai`, `openai-responses`, `anthropic` or `bedrock`. |
| `baseUrl` | yes | The base URL of the endpoint. See `baseUrl` below. |
| `auth` | yes | The key command `{ "command": [...], "ttlSeconds": 300 }`, or `"none"` for a server that checks no key. See `auth` below. |
| `models` | yes | A map of model id to [model](#models). At least one. |
| `allowHttp` | no | `true` allows an `http:` `baseUrl` for this provider only. Default `false`. |
| `headers` | no | Extra request headers. Names cannot hold `auth`, `key`, `token`, `secret`, `password`, `credential`, `cookie`, `session` or `signature` (any case). Values must be printable ASCII. Every inference request sends `User-Agent: klyth/<version>` by default. See request header order below. |
| `params` | no | Body keys merged into every request. See [Request bodies](#request-bodies). |
| `timeoutMs` | no | A positive integer, at most 2,147,483,647 (about 24 days). See Timeouts below. |
| `maxTools` | no | A positive integer. Default `128`. Klyth drops tools past the cap, and `/klyth` lists them. |
| `sessionHeader` | no | The name of a header that carries a per-conversation id. Any kind. See `sessionHeader` below. |
| `streamUsage` | no | `openai` kind only. Default `true`: Klyth sends `stream_options.include_usage`. |
| `authHeader` | no | `anthropic` kind only: `bearer` or `x-api-key`. Default `x-api-key`. The other kinds send `Authorization: Bearer`. |

Header precedence, low to high, is the Klyth default, the provider's configured `headers`, then the session header. A
login that rewrites a provider removes a stale `User-Agent` header from `headers`, in any case, and keeps the other
headers.

A key that belongs to another kind is an error (`providers.<id>.<key>: unknown key`). `apiKeyEnv` is an error that names
`klyth auth login api-key <id>`.

**`baseUrl`.** The URL must use `https`, unless the provider sets `allowHttp: true`. It must not have credentials, a
query, a fragment, a backslash, whitespace, or any of `[ ] { }` (URL templates and IPv6 literals are not supported). The
host is a DNS name with at least two labels, or an IPv4 address. `127.0.0.1` is valid. Klyth refuses `localhost`. A port
is valid. Klyth drops trailing slashes and refuses inference redirects. Use HTTPS, or an encrypted tunnel to loopback,
because a private LAN does not encrypt an HTTP hop. Provider approval binds to the kind, the URL origin (scheme, host
and port), and the exact command argv or keyless mode. It does not bind to the path, model or params. With the installed
launcher, the argv stays the same across updates. An approval does not bind to the launcher's contents, the Klyth release,
Bun or a script hash. A Klyth update changes the code that runs under an approved launcher command. To require approval
for each release, set `auth.command` to that release's own `scripts/cli.ts` path. The line 2 marker shows ownership. It
is not an authenticity check. Klyth requests `<baseUrl>` plus the path of the kind:

| Kind | Path added |
| --- | --- |
| `openai` | `/chat/completions` |
| `openai-responses` | `/responses` |
| `anthropic` | `/v1/messages` (and the header `anthropic-version: 2023-06-01`) |
| `bedrock` | `/model/<model id, URL-encoded>/converse-stream` |

**`auth`.** Use a command for an authenticated provider, or `"none"` for a keyless endpoint. There is no
environment-variable form, and `auth.env` is an error.

- `command` is a non-empty list of strings. The first string is an absolute path. Nothing expands `~` or searches
  `PATH`. No string may hold a control character.
- Klyth runs the command with no shell, with stdin closed and with a 10 s limit. It runs the command only after you
  approve the provider, and only when a step needs a key. Startup and `/klyth` run nothing. The trimmed output is the
  key, with 1 to 4096 visible ASCII characters and no spaces. Klyth never logs the key.
- `ttlSeconds` is a positive integer, default `300`. It sets how long klythd keeps the key in memory. On an ordinary
  request, a 401 or 403 drops the cached key. If the rejected key came from the cache, Klyth runs the helper once more
  and retries before any output. Compaction and guarded dispatch requests make one attempt.
- Examples: [Keychain, `secret-tool`, `pass`, `op read`](PROVIDERS.md#keys). A ChatGPT sign-in uses
  `klyth auth token <provider>` with `"ttlSeconds": 600`. See
  [OpenAI with your ChatGPT plan](PROVIDERS.md#openai-with-your-chatgpt-plan).
- `"auth": "none"` is for a server that checks no key (a local Ollama or vLLM). Klyth runs no command and sends no
  `Authorization` or `x-api-key` header. You still approve the provider once, and a change between a command and
  `"none"` asks again. Over plain http, the prompt warns that anyone on the path can read or change prompts and answers.
  `bedrock` always needs a key, so `"none"` is an error there. The spelling is exact: `"None"` is an error. Never put a
  token in `klyth.json`.

**`sessionHeader`.** A provider may use the id as part of its cache identity, but a stable id does not guarantee a cache
hit. A good value is `session-id`. `session_id` is a different header. The
secret-name rule of `headers` does not apply, because the value is a random id. Klyth refuses `authorization`,
`x-api-key`, `content-type` and `user-agent`, which it sets itself. With a `sessionHeader`, the `openai-responses` kind
also sends the id as `prompt_cache_key`, unless `params` set one.

Klyth sends one id per loop. Main keeps its id through `/clear`, `/compact`, model switches, reloads, klythd restarts
and resumes, and each subagent keeps its own id. The ids are cache identities, not permission grants. The fork context
of the [classifier](#classifier) sends the id of its loop, and the fresh context sends none.

**Timeouts.** Without `timeoutMs`, Klyth has no limit on the total request time. Klyth cuts a request when no data
arrives for 600 s (the stall window). With `timeoutMs`, the whole-request limit is that many milliseconds. The stall
window is the smaller of 600 s and `timeoutMs`. Connecting has a 15 s limit.

## Models

A model id is any non-empty string. Klyth sends it to the provider unchanged. It may hold `/` or `:` (`openai/gpt-4.1`,
`openai.gpt-oss-120b-1:0`).

| Key | Needed | Meaning |
| --- | --- | --- |
| `contextWindow` | yes | A positive integer: the window of the model in tokens. |
| `maxOutputTokens` | yes | A positive integer. |
| `maxInputTokens` | no | A positive integer, at most `contextWindow`. |
| `effort` | no | A map of level to body params. See [Effort](#effort). |
| `cache` | no | `anthropic` and `bedrock` kinds: `"5m"` or `"1h"`, the requested cache retention. Without it, Klyth sends no explicit cache markers. See [Prompt cache](#prompt-cache). The `openai` and `openai-responses` kinds refuse this key, because the provider controls any caching. |
| `pricing` | no | USD rates per million tokens. Only `/klyth usage` reads them. See [Pricing and usage](#pricing-and-usage). |
| `tools` | no | Default `true`. `false` sends no tools, `SubagentHandback` included ([how such a subagent reports](TROUBLESHOOTING.md#which-subagents-run-on-an-alias)). |
| `vision` | no | Default `true`. `false` turns images into a text note. |
| `params` | no | Body keys merged into every request to this model. |
| `headers` | no | Extra headers for this model. They win over the headers of the provider. |
| `maxTokensParam` | no | Model level only. `openai` kind: `max_tokens` or `max_completion_tokens`. `openai-responses` kind: `max_output_tokens`. Other kinds refuse it. Without it, Klyth adds no max-tokens key for these two kinds. Explicit `params` still apply. |
| `systemRole` | no | `openai` kind only: `system` (default), `developer`, or `user` (sent as a first message that starts "System instructions:"). |
| `parallelToolCalls` | no | `openai`, `openai-responses` and `anthropic` kinds. Default `true`. `false` sends `parallel_tool_calls: false` (the two openai kinds) or `disable_parallel_tool_use` (anthropic). |

The `anthropic` and `bedrock` kinds always send `maxOutputTokens` as the max-tokens value.

**Input budget.** The budget is the smaller of `maxInputTokens` (when set) and `contextWindow` minus `maxOutputTokens`.
The subtraction applies when the request carries a max-tokens value: always on `anthropic` and `bedrock`, and on the two
openai kinds only with `maxTokensParam`. A model that leaves no budget is a config error. `/model <alias>` warns above
0.85 of the budget but still selects the route, so `/compact` can use it. Klyth does not send a step above 0.95 of the
budget. The error names the 95% safety threshold and says `run /klyth compact between turns`. The size of a conversation
is the prompt that its last routed response reported, while its transcript has not shrunk since. Otherwise it is an
estimate: the characters of the request divided by 3.5.

### Pricing and usage

`pricing` belongs on a model, not on a provider or alias. Rates are USD per million tokens, and only `/klyth usage`
reads them. `pricing` needs `currency` (it must be `"USD"`) and `perMillionTokens`. The parser rejects unknown keys,
nulls, and negative or non-finite values. An omitted rate stays unpriced, and a rate of `0` is an explicit zero price.
The `tiers` array is optional. This example uses illustrative rates, not provider prices:

```json
"pricing": {
  "currency": "USD",
  "perMillionTokens": { "input": 1, "output": 4, "cacheRead": 0.25, "cacheWrite": 1.5 },
  "tiers": [
    { "aboveInputTokens": 272000, "perMillionTokens": { "input": 2, "output": 8, "cacheRead": 0.5, "cacheWrite": 3 } }
  ]
}
```

- A `perMillionTokens` object may be empty or hold only the rates you know. `cacheWrite` is one number for every counted
  cache-write token, or a map with `5m` and/or `1h`. A TTL map prices a write only when the response names the variant,
  because the requested `cache` setting is not evidence of a billed variant.
- Tier thresholds are nonnegative safe integers in strictly increasing order. Every tier needs a `perMillionTokens`
  object. The selected table replaces the base table, so omitted rates stay unknown.
- For each provider attempt, Klyth selects the highest threshold strictly below the final reported total input (cache
  reads and writes included). So 272,000 input tokens use the base rates and 272,001 use the tier. The rates apply to
  the whole request. If the total input is unknown, a nonempty schedule selects no table, and the cost stays incomplete.
- Each request keeps the rates it started with. The estimates are not a bill or an incremental subscription charge.

`/klyth usage` opens a native pane after the current main turn ends. `/klyth usage text` prints the same local
totals. If the pane cannot open, Klyth prints the text. The pane starts with session controls and their shortcuts.
The filters All, Main conversation, Subagents, and Checks and summaries change only the model rows.
The session total stays the same. Klyth counts routed conversation requests, subagent requests, auto mode checks, and
conversation summaries. A request is one routed unit of work. A run is one Klyth execution. A provider call is one
attempt, including a retry.

The report starts with `Estimated cost:` and a warning if totals may be incomplete. Model rows follow.
`Session details` comes after the model rows. It shows which requests have usage data. Numbers use full digits with
thousands separators. `Input tokens from cache` shows the share of eligible input tokens that came from cache.
Klyth calculates this share from token totals, not the mean of the provider-call percentages.
Reasoning tokens form part of output, so Klyth does not count their cost twice.
The estimate is not a bill or an extra subscription charge. It excludes fees that the protocol does not expose.
Totals cover this session and its subagents. `/clear` starts a new total. Viewing usage sends no inference request.

Empty sessions show `No requests yet.` Requests in progress show `Work in progress.` Missing prices show
`Some usage has no cost estimate. Add model prices under pricing in klyth.json.` Missing counts show
`Some token counts are missing. Run another request to check usage data.` A partial estimate starts with `At least $`.
Klyth never shows unknown cost as zero. Open a model row to see its full name and token counts.

Klyth tries to save usage under the plugin store key `usage:v1`. The host shares a 4 MiB limit across all plugin records.
If a save fails, the pane shows `Klyth could not save usage. Totals may be incomplete.`
If Klyth can no longer update the record, it shows `Klyth cannot update this usage record. Totals may be incomplete.`
Both states say `Print this report to keep the current totals.` Use Print report or `/klyth usage text`.
Saved usage holds counters, details of pending requests, and the transcript path. It never holds transcript
content or credentials. Klyth removes an inactive session's record when its transcript is gone.

## Compaction

On a routed loop, `/compact` and engine-triggered compaction summarize through the chosen, approved provider. They never
use native inference. Native loops keep the native summarizer. `/klyth compact [instructions]` queues the built-in
`/compact` command after its own command returns. Summaries are context data, not new user requests or permission
grants. Cancellation, failure, or a stale route, config or history keeps the history intact.

| Key | Meaning |
| --- | --- |
| `hostWindow` | An integer from 100,000 through 1,000,000, or `false`. Default `777000`. See [Host compaction window](#host-compaction-window). |
| `deliveryRecovery` | A boolean. Default `true`. See [Delivery recovery aid](#delivery-recovery-aid). |

Any other key, any other type and any value out of range is an error.

### Delivery recovery aid

`compaction.deliveryRecovery` is `true` by default for every valid config, also when the `compaction` section is
missing. `hostWindow: false` does not disable it. To opt out, set:

```json
{ "compaction": { "deliveryRecovery": false } }
```

Before the normal tool call runs, Klyth copies the text of supported local `SendMessage` calls into private files. It
does not change permission checks, consume messages, delay delivery or resend the call. An invalid or missing config, or
the opt-out, stops new capture. Existing backups stay available.

- Coverage is narrow. Klyth backs up a send to an exact local agent id from the roster of the current host. It also
  backs up a send to `main` from a first-generation local child. Klyth does not guess names, ambiguous addresses,
  teammate processes, remote sessions or unproven grandchild `main` aliases. It captures no `session.send` calls, user
  prompts, task notifications or media. When it cannot back up a send, it warns at most three times per engine session,
  and the original send still runs.
- Backups live in `<configDir>/klyth/delivery-recovery/<engine-session-id>/<recipient>/<record-id>/` (directories 0700,
  files 0600 and immutable). The limits are 64 KiB of UTF-8 text per message, 128 records and 8 MiB per engine session,
  and eight manual restore attempts per record. At a limit, Klyth never truncates, evicts, expires or removes earlier
  evidence. Treat these files as private message history when you manage backups or share diagnostic material.

The commands change nothing until you approve a restoration:

- `/klyth recovery` lists the records of the current session by recipient, with what Klyth observed for each.
- `/klyth recovery show <id>` shows the captured context in the UI, not in model history.
- `/klyth recovery restore <id>` needs an interactive confirmation. It rechecks the engine session and the exact running
  recipient. Then it appends a **Klyth recovery copy** with a recovery marker, quoted source metadata and an explicit
  denial of new instruction or approval authority. Klyth never restarts a stopped child or retargets it to main.
- `/klyth recovery dismiss <id>` needs confirmation and keeps the backup.

Klyth does not replay a completed restore. An interrupted append leaves **restore outcome unknown**, and Klyth never
retries it automatically. After a restart or resume, a manual retry needs an extra explicit confirmation of the
duplicate risk. The original message or an earlier copy may have arrived already. This is recovery assistance. It is
**not** an automatic delivery barrier, original-provenance replay, exactly-once processing or universal ingress
coverage. [Delivery recovery](TROUBLESHOOTING.md#delivery-recovery) lists each observation.

### Host compaction window

`compaction.hostWindow` is `777000` by default for every valid config, also when the section or the value is missing.
Klyth applies it through the process-wide environment variable `CLAUDE_CODE_AUTO_COMPACT_WINDOW` on load and on
`/klyth reload`. The host then decides when to compact. All loops share the window, native loops included.

- The window is not the trigger. Claude Code 2.1.296 subtracts a 33,000-token buffer, so 777,000 gives a measured
  744,000-token trigger. Other host versions may use a different buffer.
- The native context window and the provider limits do not change. `DISABLE_AUTO_COMPACT`, `DISABLE_COMPACT`,
  `autoCompactEnabled` and the 95% routed safety guards stay in force. A shared window cannot guarantee that every
  smaller routed input budget fits.
- An explicit `false`, or an invalid or missing config, restores the original value of the variable. This happens only
  while the current value is still the value of Klyth.
- A failed write or handoff makes Klyth decline further changes and ask for a restart. Klyth passes ownership across
  `/clear` and resume in a transient `KLYTH_HOST_WINDOW_HANDOFF` environment record, never on disk.
  [Routed compaction recovery](TROUBLESHOOTING.md#routed-compaction-recovery) lists the debug messages.

**Restart Claude Code after you disable Klyth.** A live plugin unload does not undo `env.set`. To restore the original
value without a restart, do these steps:

1. Set `hostWindow` to `false`.
2. Run `/klyth reload` while Klyth still runs.
3. Disable Klyth.

### Routed summary requests

The routed summarizer decides how a routed loop makes and checks its summary. A returned tool call, a refusal or an
incomplete summary rejects the compaction.

- The request asks for at most 8,000 output tokens, only when the protocol and model declare support. Without a declared
  limit, the prompt asks for concise output and Klyth rejects a summary over 32,000
  characters. Cancellation does not cap billing, because reasoning usage may arrive only at the end.
- Automatic compaction of main queues an idle command. It queues the command when a turn completes, or at the first safe
  idle point of a cold or resumed session. The threshold is the smaller of 78% of `contextWindow` and 90% of the input
  budget. That is 780,000 for a 1M window with 872,000 input tokens.
- The engine switch for disabled auto-compaction, or `autoCompactEnabled: false` in settings, turns this scheduler off.
  A failed attempt cools down for a minute. Klyth schedules no compaction for child loops.
- If the prefix is too large, an **uncached chunk recovery** path quotes the history as JSON in at most four chunks and
  one reduction. Klyth never resends a request automatically.

## Request bodies

Klyth builds each request body in this order, and a later step wins. A `null` value removes the key at any step.

1. The base of the kind: the max-tokens key, and the no-parallel-calls flag when it is off.
2. The `params` of the provider.
3. The `params` of the model.
4. The `params` of an alias, when the request goes through an alias that has them. See [Aliases](#aliases).
5. The params of the applied `effort` level. The `effort` map of an alias replaces the whole map of the model.
6. The own keys of Klyth, which `params` may not set:

| Kind | Keys Klyth sets (refused in `params`) |
| --- | --- |
| `openai` | `model`, `messages`, `tools`, `stream`, `stream_options`, `n`, `tool_choice`, `functions`, `function_call` |
| `openai-responses` | `model`, `input`, `instructions`, `tools`, `tool_choice`, `stream`, `store`, `previous_response_id`, `conversation`. With a `sessionHeader`: `prompt_cache_key` (the loop's id), unless `params` set it. |
| `anthropic` | `model`, `messages`, `system`, `tools`, `tool_choice`, `stream`, `max_tokens` |
| `bedrock` | `messages`, `system`, `toolConfig` |

For `bedrock` the base is `inferenceConfig.maxTokens`, so a `params` entry such as `inferenceConfig.temperature` merges
into it. An `openai-responses` request always carries `stream: true` and `store: false`. It is stateless, and every step
sends the whole conversation.

## Prompt cache

`cache` on a model of the `anthropic` or `bedrock` kind asks the provider to cache the start of every request. Klyth
puts marks where the prefix stops changing, at most four, which is the limit of the providers:

| Kind | Marks | Body field |
| --- | --- | --- |
| `anthropic` | the system prompt, the last tool, the last block of the last two user turns | `cache_control: { "type": "ephemeral", "ttl": "5m" }` (or `"1h"`, the `cache` value of the model) |
| `bedrock` | after the system prompt, after the tools, at the end of the last two user turns | `{ "cachePoint": { "type": "default" } }`, with `"ttl": "1h"` for `1h` |

Provider support, minimum prefix size and retention still decide cache hits. A prefix under the minimum of the model is
not cached, and the request still succeeds. The minimum is 512 tokens for Sonnet 5.5 and 4,096 for Haiku 4.5 (Bedrock
model cards). The debug line shows the tokens read from and written to the cache as `cache=` and `wrote=`. A model with
no `cache` key gets no marks. A change of the effort or of the thinking settings between requests can change the
cacheable prefix and cause a miss.

After a completed routed child resumes, the host can pile `SendMessage` delivery wrappers into its opening user turn and
change the cached prefix. Klyth moves each attested wrapper to its own user turn, in the provider copy only. It discards
no text, and sender text never becomes owner consent. Provider retention can still miss the cache. See
[the cache seam log](TROUBLESHOOTING.md#completed-child-resume-cache-seam).

## Thinking

Claude takes its thinking settings as body params, so they are config like effort:

| Kind | Where | Example |
| --- | --- | --- |
| `anthropic` | top level of the body | `"thinking": { "type": "adaptive" }`, `"output_config": { "effort": "high" }` |
| `bedrock` | inside `additionalModelRequestFields` | `"additionalModelRequestFields": { "thinking": { "type": "adaptive" }, "output_config": { "effort": "high" } }` |

Claude Sonnet 5.5 and Opus 5.5 think adaptively without a `thinking` param. Their `output_config.effort` takes `low`,
`medium`, `high`, `xhigh` or `max`. On the Claude API they omit the thinking text by default, and only the signature
arrives. `"thinking": { "type": "adaptive", "display": "summarized" }` asks for a summary. Through Bedrock Converse,
`display: "summarized"` may still show no thinking text. The signed block arrives and Klyth carries it over.

Claude Haiku 4.5 has no effort and takes `"thinking": { "type": "enabled", "budget_tokens": 4096 }`. The budget must be
below `maxOutputTokens`. Validation checks this wherever you set the budget: model, effort level, provider or alias
params. For provider params, the smallest `maxOutputTokens` among its models applies. For an alias, the limit of its
target model applies.

Klyth keeps each signed (or redacted) thinking block of a turn that called tools. On the next step, it sends the blocks
back in that turn, each in the place it came from, as the providers require.

**Response records.** klythd keeps the provider metadata of every routed response in
`<configDir>/klyth/responses/<engine-session-id>.jsonl` (directory 0700, file 0600), one file for each engine session.
The file holds:

- The ids and hashes that link a response to its history.
- The signed or redacted thinking blocks of tool turns (`anthropic` and `bedrock`) and the encrypted reasoning items
  (`openai-responses`).
- Each klyth agent call as the model made it, and the path of the host transcript.

The file never copies the messages of the transcript. Thinking text is plaintext that the provider needs back verbatim,
and it can quote tool output. Blocks go back only to the model that wrote them, on the same provider endpoint.

- The file is append-only (about 10 to 20 MB for a reasoning-heavy session of about a thousand tool calls). It lives as
  long as the transcript of the session. A klythd process that first opens a store in that config directory removes the
  file of every other session whose recorded transcript no longer exists.
- Without a session scope from the host (for example, `CLAUDE_CONFIG_DIR` is not an absolute path), klythd keeps the
  records in memory. The step line then shows `store=memory`. A klythd restart loses the blocks and the original form of
  klyth agent calls, so the provider gets `Agent` calls.
- klythd exits after 10 idle minutes. When a model or alias sets `"cache": "1h"`, it exits after 65 idle minutes, so it
  stays warm for the one-hour cache.

To purge a session, remove its transcript. The next klythd process that opens a store in that config directory removes
the file. Or close Claude Code for that session and move the file to the Trash, because a running klythd keeps appending
to a removed file. Trashing the file also drops the original form of the klyth agent calls of that session, so its next
request misses the prompt cache once.

If klythd cannot open or write the file, it refuses the step with `klyth: responses store unavailable (<code>): …`.
[Response records](TROUBLESHOOTING.md#response-records) lists each code and fix. Klyth never sends a request with
silently different history.

**Missing blocks.** The blocks of a tool turn can be missing:

- Another model or endpoint made the turn.
- The turn was cut before its blocks arrived.
- The step ran from memory and klythd restarted.

A request that asks for thinking (`"type": "enabled"` or `"adaptive"`) then goes out without the `thinking` param. The
step does not fail, and the debug line says `note="thinking param left out: …"`. A model that thinks by default keeps
thinking, and Klyth sends `"type": "disabled"` as written. Klyth shows a thinking block with no signature and does not
keep it.

## Effort

`effort` maps a level (`low`, `medium`, `high`, `xhigh`, `max`) to a params object. Other keys are errors. Klyth picks
the level in this order:

1. The `effort` of a `mcp__klyth__agent` call or a plain `Agent` call.
2. The `effort` in the definition file of a custom agent.
3. The effort of your session.

Klyth applies that level when the model declares it. Otherwise it applies the nearest declared level below, or the
nearest declared level above when none is below. A model with no `effort` map gets none. To cap effort, declare levels
only up to `medium`. Every higher request then resolves to `medium`.

For Claude, the params of a level carry the effort field of the provider. On the `anthropic` kind:

```json
"effort": { "low":  { "thinking": { "type": "adaptive" }, "output_config": { "effort": "low" } },
            "high": { "thinking": { "type": "adaptive" }, "output_config": { "effort": "high" } } }
```

On the `bedrock` kind, the same objects sit inside `additionalModelRequestFields`. Check which levels a model takes in
its model card (`xhigh` and `max` are not on every model). An unsupported level is an error from the provider, not from
Klyth.

## Aliases

An alias is a name for a target. It starts with a lowercase letter and holds lowercase letters, digits, dashes and dots.
It has at most 64 characters, so it can be the name of a model (`gpt-5`). It has no `/`, no leading dot and no `..`.
Klyth reserves `fable`, `opus`, `sonnet`, `haiku`, `default`, `inherit` and `native` as built-in model names.

- The value is `"provider/model"` or `{ "target": "provider/model", "note": "..." }`. A note is one line of at most 120
  characters. It shows in the `/model` completions and in the description of the Klyth agent tool.
- An object value may also carry the request keys of a model: `params`, `effort`, `cache` and `headers`. They apply only
  to requests made through the alias, so one model can have several aliases that ask for different things. A direct
  `provider/model` target keeps the own values of the model. A `native/` target takes none of them.
- Klyth checks alias `params` like model params: the same reserved keys for the kind of the target, and the same `cache`
  rule. `params` merge in the order of [Request bodies](#request-bodies). `headers` merge over the headers of the model.
  `effort` and `cache` replace those of the model. `"cache": null` on an alias turns off the cache that its model sets.
- A route stores the alias name, and each step resolves it again. So the request keys of the alias apply to every
  request through it. This holds for `/model <alias>`, the Klyth agent tool and a plain `Agent` call under a routed
  parent.
- `provider/model` works wherever an alias does. It splits at the first `/`, so `openrouter/openai/gpt-4.1` is provider
  `openrouter` and model `openai/gpt-4.1`.
- `native/<model>` names a native model. `/model native/sonnet` switches to it, and an alias may target it.
- A target must name a declared provider and model, or validation fails with the path.

```json
"aliases": {
  "sonnet55-fast": { "target": "bedrock/global.anthropic.claude-sonnet-5-5",
                     "effort": { "low": { "additionalModelRequestFields": { "thinking": { "type": "adaptive" }, "output_config": { "effort": "low" } } } } },
  "sonnet55-deep": { "target": "bedrock/global.anthropic.claude-sonnet-5-5", "cache": "1h",
                     "effort": { "high": { "additionalModelRequestFields": { "thinking": { "type": "adaptive" }, "output_config": { "effort": "high" } } } } }
}
```

Both aliases name one model. The first asks for low effort and sends no explicit cache markers, because the model has no
`cache`. The second asks for high effort and one-hour cache retention.

## Classifier

The classifier is off until `klyth.json` has a `classifier` key. `"classifier": {}` turns it on with the defaults below.

A routed turn has no native auto mode verdict, so Claude Code refuses the actions that auto mode would check
([the refusal](TROUBLESHOOTING.md#routing-and-subagents)). The classifier is an opt-in stand-in for that verdict. It
acts only when Claude Code reports `Classifier unavailable`, in auto mode, for a routed conversation or subagent.

1. Eligible actions first open a native approval pane. The pane shows the actor, the tool, the complete escaped action,
   **Allow once**, **Deny** and an 8-second countdown.
2. **Allow once** approves only that exact action, not a permissions rule. Klyth answers Claude Code with `retry`. The
   assistant issues the action again, and that one call runs.
3. Deny, Esc, dismissal, cancellation, a changed action, session or policy, or a loss of pane visibility leaves the
   action blocked, with no model fallback.
4. When the 8 seconds expire, Klyth sends one request to the classifier model. Silence is not consent: the model must
   ask for every risky or uncertain action, even if a conversation request authorizes it. Failures stay blocked.

An unplaced pane (on a narrow terminal, say) closes at once, and the refusal stands. In that case, use normal mode or
your own permission rules. One question is open per session. Explicit denies, rules, hook asks and managed ceilings
never enter this flow.

An allow shows nothing. The re-issued call runs, and the allow is in the debug log. When the classifier declines or
skips an action, a `klyth: classifier:` line says why.
[The auto mode classifier](TROUBLESHOOTING.md#the-auto-mode-classifier) lists each line, the pane limits and what to do.

### Classifier settings

```json
"classifier": { "model": "same", "context": "fresh", "tools": "bounded", "timeoutMs": 20000, "tokenMs": 20000, "maxPerTurn": 20 }
```

| Key | Needed | Meaning |
| --- | --- | --- |
| `model` | no | The model that classifies. `"same"` (default) is the model of the loop. Otherwise an alias or a `provider/model` of this file. A `native/` target is an error, because a native model cannot classify a routed turn. Its provider must be approved already (select it once with `/model`). With `"context": "fork"` it must be `"same"`. |
| `context` | no | What the classifier reads. `"fresh"` (default) is a context that Klyth builds. `"fork"` is the conversation of the loop itself, and is weaker against injected content. |
| `tools` | no | Which tools the classifier decides. `"bounded"` (default) covers file edits under the path rules (`Edit`, `Write`, `NotebookEdit`) and a `WebFetch` of a URL you typed. `"all"` covers every tool that Claude Code refuses for want of a verdict. **Use `"all"` only with trusted repositories and sources.** Read [Tools all](#tools-all) before you set it. |
| `timeoutMs` | no | A positive integer, at most `45000`. Default `20000`. How long one classifier request may take. Klyth cuts a request that is still unanswered 5 s after that. Raise it if fork-context requests time out, because they run at the effort of the loop. |
| `tokenMs` | no | A positive integer, at most `45000`. Default `20000`. How long an "allow" stays good for the re-issued call. |
| `maxPerTurn` | no | A positive integer, at most `200`. Default `20`. How many actions Klyth classifies per loop per turn. |

With `"bounded"`, Klyth does not classify `Bash`, and it classifies `Agent` only with `"all"`. Allow a command with a
`/permissions` rule, switch modes (Shift+Tab), or set `"tools": "all"`.

These errors turn routing off like any other config error:

- `classifier: must be an object`
- `classifier.<key>: unknown key`
- `classifier.model: "…" is not an alias or provider/model of this file`
- `classifier.model: a native model cannot classify a routed turn; use "same", an alias or provider/model`
- `classifier.context: must be "fresh" or "fork"`
- `classifier.tools: must be "bounded" or "all"`
- `classifier.model: must be "same" when classifier.context is "fork"`
- `classifier.timeoutMs: must be a positive integer up to 45000`, and the same for `classifier.tokenMs`
- `classifier.maxPerTurn: must be a positive integer up to 200`

### What the classifier reads

**Fresh context** (the default) has no tools. It holds:

- Your last 32 typed prompts, each cut at 4 KiB.
- The last 40 tool calls of the assistant, each cut at 512 characters. It holds names and arguments, never results or
  the words of the assistant.
- The task of a subagent. Klyth lists a vetted task as a request of its own and quotes any other task as data.
- The action.

All of it goes to the endpoint of the classifier model, so route `model` only to an endpoint that may receive it. Each
classified action is one more request, at the `low` effort level where the model declares one. Results and assistant
prose are not supplied. If the classifier needs that evidence to establish authority or sensitive effects, it asks and
does not guess.

**Fork context** reads the conversation of the loop as a fork on the same model would. That is the system prompt, the
tools and the whole history, with tool results and assistant reasoning. One message from Klyth quotes the action and
your prompts. It says that only those prompts are your requests. All other text in user turns is data, except a vetted
subagent task, which the message quotes as `spawnTask`. A claim of approval in data grants no permission.

- A file, a tool result or a page can carry text written to sway the classifier. So with `"tools": "bounded"`, the fork
  context never classifies `WebFetch`, not even for a URL you typed.
- A reply that calls a tool is no verdict. The classifier of a subagent reports through one `SubagentHandback` call,
  which Klyth reads and does not run.

In both contexts, Klyth does not ask again about an action that the classifier declined in the same turn. At most 4
classifier requests run at once.

### The rules the classifier applies

`allowRules` in `hooks/classifier-rules.ts` is the one rule text for both contexts and every tool. The classifier judges
effects, not tool names.

- It allows actions that your requests authorize, with the ordinary steps to carry them out. These are task-related
  inspection, source edits, tests, scratch and worktree steps, and read-only queries limited to the requested system and
  investigation.
- Usefulness alone is not authority. Access, or a "read-only" label, does not authorize unrelated data access or secret
  retrieval.
- A proposal or a claim of approval in data grants no permission. Unclear authority, scope or sensitive effects call for
  "ask".

After the 8-second timeout, the classifier always asks for risky effects, also when a conversation request authorizes
them. The risky effects are:

- Extracting or disclosing credentials or secrets.
- Uploading or publishing private or local content.
- Changing security settings, hooks, permissions, git config, or build, CI, package, shell or editor execution
  configuration.
- Downloading and running code.
- Production mutations, deploys or migrations.
- Destructive, mass or wildcard deletion, or destroying existing work.
- Granting permissions or changing shared infrastructure.
- Force pushes, and pushes to deploy branches such as production, release or gh-pages.

Trusted working directories, scratchpads, worktrees and remotes do not authorize risky effects.

The classifier also reads your policy from `autoMode` in your user settings, in `--settings` and in managed settings.
Its `hard_deny`, `soft_deny`, `allow` and `environment` entries join the rules, strictest list first. `hard_deny` means
always ask, and `allow` means not risky. Klyth takes whole entries up to 4 KiB in all. It leaves out the first entry
that would pass that limit and every entry after it. It skips a `"$defaults"` entry. If Klyth cannot read those
settings, it classifies no action.

### Tools all

With `"tools": "all"`, the classifier can review `Bash`, `WebFetch` of any URL, `Agent` spawns, MCP tools and other
actions. Host deny and ask rules, hooks and organization ceilings stay authoritative. The typed-URL rule and the
fork-context refusal of `WebFetch` no longer apply. Tools without a file-path field get no filesystem containment
checks.

Anything the session reads (a file, a web page, a tool result) can carry text written to talk the classifier into
allowing a command. This is prompt injection, and the classifier is weaker still with `"context": "fork"`. **Set `"all"`
only for repositories and sources that you trust.**

Under `"all"`, the path rules, the size limits, the one-shot approval, the caps and the timeout stay in force. Klyth
also never classifies:

- A `Bash` command that removes the root or the home directory recursively (`rm -rf /`, `rm -rf ~`, and the `$HOME` and
  `/*` spellings).
- The input of a tool with no path that names a never-classified path (`.claude/`, `.git/`, `~/.claude.json`, `.env`,
  `~/.ssh/`) or git's `core.hooksPath`. An `Agent` task is exempt.

A git worktree under `.claude/worktrees/` is not such a path, so Klyth classifies a worktree. Its own `.git`,
`.claude/`, `CLAUDE.md` and credentials still count. This exception matches the text literally. It does not apply when
`..` stands anywhere in the input, and it never covers a worktree under `~` or another directory. These guards catch
literal spellings only. A variable, a glob, a path that a command builds, or a symbolic link (such as
`.claude/worktrees/up` pointing to `..`) evades them. So under `"all"` the classifier model is the real check.

Klyth classifies an `Agent` spawn on its task description before the subagent starts, and asks when the task itself
calls for a risky action. Protected names do not apply to the prose of a task, but the size limit does. Routing alone
grants no approval. Klyth does not review the report of a finished subagent.

### Scope and subagents

- **Plan and memory artifacts.** Concrete Markdown documents under `plans/` and `projects/<project>/memory/` in the
  config directory, and under `.claude/plans/` in the session project, may reach review without a path that you typed.
  Eligibility never grants permission. The path must stay in the artifact root, also after symlinks resolve. Other
  protected names, credentials, settings, agents, hooks, plugin files and the installed Klyth root stay protected. Under
  `"all"`, only exact literal artifact paths leave the `.claude` name check.
- **`SendMessage`.** Klyth trusts a local parent or child relationship only when exact roster ids establish it. That
  evidence is never consent.
- **Protected working directories.** The working directory can be the installed Klyth checkout, the config directory of
  Claude Code, home, or an ancestor of home. There, the classifier grants no opaque execution (`Bash`, `Monitor`,
  unknown tools, MCP) and no file write to protected roots or through links. It can still review native inspection and
  search tools, `WebFetch`, `SendMessage` and `Agent` tasks, within the coverage of `tools`. For source edits and tests
  of the installed plugin, use a `.claude/worktrees/<name>` worktree, or act manually under your own permission rules.
- **A subagent's task.** Claude Code judges the actions of a subagent with the task of that subagent as its request.
  Klyth does the same only for a task that no routed model wrote or vetted itself:
  - A routed subagent that a native main conversation started with its own `mcp__klyth__agent` call.
  - A subagent whose `Agent` call spent a human Allow once or a fresh-classifier allow (with `"tools": "all"`) for the
    very task that it received. An allow of the fork context vets no spawn.

  Every other task stays data. A vetted task counts whole for the classifications of that subagent only, so Klyth does
  not classify a task over 16 KiB. A subagent of a subagent never counts the vetted task of its parent. Klyth forgets
  the mark when the subagent ends or the hooks reload. A vetted task never makes a path or a URL "typed".
- **Differences from Claude Code auto mode.** The rules follow what
  [Claude Code auto mode](https://code.claude.com/docs/en/permission-modes) blocks by default, and the protected paths
  follow its list. The classifier is a routed model that reads prose rules and learns nothing between turns. Its `rm`
  check covers only an `rm` of `/` or `~` spelled out in the command. The fresh classifier does not read `CLAUDE.md`,
  and the classifier reads no project settings.

### Protected paths

Klyth matches protected paths case-insensitively against the part of a path below the directory (the whole of a path
outside it). It checks the written path and the real one, typed or not. Two lists in `hooks/classifier-rules.ts` define
them.

`SELF_ESCALATION` and `SECRETS` are never classified, because an allow there could switch off a safeguard:

- Claude Code and instruction files: `.claude/`, `.claude-plugin/`, `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md`,
  `AGENTS.md`.
- Git files and hooks: `.git/`, `.gitconfig`, `.config/git/`, `.husky/`, `.githooks/`, `.pre-commit-config.yaml`,
  `lefthook.yml` and its variants.
- `.claude.json` and its `.claude.json.backup*` files.
- Credentials: `.npmrc`, `.pypirc`, `.env*`, `.ssh/`, `.aws/` and the like.
- The files of Klyth (`klyth.json`, `.cache/klyth/`) and the migration-source paths (`styx.json`, `.cache/styx/`).
- The folders that Klyth guards by name: its own and the config directory of Claude Code.

Klyth guards a link to one of these too. Klyth does not see a hard link made earlier, because the stat that Claude Code
gives Klyth reports no link count.

Klyth classifies `SENSITIVE` paths and marks the action `protectedPath`. The classifier checks the effects, and risky
changes need explicit authority for the effect and the affected target. The list holds:

- Shell startup files: `.bashrc`, `.zshrc`, `.profile` and kin.
- `.envrc`, `.gitattributes`, `.gitmodules` and `node_modules/`.
- Editor and tool folders: `.vscode/`, `.idea/`, `.cursor/`, `.cargo/`, `.devcontainer/`, `.yarn/`, `.mvn/`.
- CI: `.github/`, `.gitlab-ci.yml`, `.circleci/`, `Jenkinsfile`.
- Build and package config: `bunfig.toml`, `.yarnrc*`, `.pnp.cjs`, `.bazelrc`, `pyrightconfig.json`, the wrapper
  properties and the rest of `SENSITIVE`.

Claude Code protects `.claude` "with a few exceptions", the first being its own git worktrees. Klyth follows that
exception. It judges a path inside `<repo>/.claude/worktrees/<name>/` from the root of that worktree, and the `.git`,
`.claude/`, `CLAUDE.md` and credentials of the worktree stay protected. It judges a file directly in
`.claude/worktrees/` by its own name, because every worktree session would read it. Klyth copies none of the other
`.claude` exceptions, except that plan and memory documents can reach review as artifacts.

### Limits

These limits do not change, and you cannot configure them.

- **Paths.** The path of a file tool must be absolute. It must lie inside the directory that Claude Code runs in (or the
  scratchpad), with no symbolic link on the way. `--add-dir`, `/add-dir` and `permissions.additionalDirectories` do not
  count as inside.
  - Klyth classifies a path outside the directory only when it stands whole in a prompt that you typed, character for
    character (`/tmp/x/run.log`). A `WebFetch` URL follows the same rule, in the fresh context only.
  - Klyth follows a link at the first folder alone (`/tmp` → `/private/tmp` on macOS) for a typed path. It refuses a
    link anywhere deeper.
  - Klyth never classifies a relative path, a path that starts with `~`, or a path with a `..` segment. It never
    classifies an action over 8 KiB or an `Agent` spawn over 16 KiB.
- **The scratchpad.** Klyth reads the scratchpad directory from one line of the main system prompt that it sent:
  `Scratchpad directory: /private/tmp/claude-<uid>/<project>/<session id>/scratchpad` (or under `/tmp`). It accepts only
  that exact shape. The rules then count the directory as part of the working directory. A scratchpad that is itself a
  link elsewhere, such as to your home folder, counts as no scratchpad.
- **It never denies.** An "ask", an unreadable answer or any failure leaves the refusal of Claude Code in place. Your
  deny rules, ask rules and hooks still apply. An allow replaces only the plain ask that auto mode would have put to its
  classifier.
- **An approval is one-shot.** It matches the tool and its whole input, every field, and only the re-issued call of the
  assistant itself. It lasts until the next routed step of the loop or `tokenMs`, whichever comes first. Klyth drops it
  sooner in these cases:
  - The turn ends.
  - Claude Code reports a permission mode other than auto.
  - A permission dialog is about to open.
  - The working directory changes.
  - Claude Code tells the assistant that auto mode ended, or that plan mode is on or ended.
  - You run `/klyth reload`.

  Within that window, a call with the identical input runs in place of the classified one. Klyth learns of a switch out
  of auto mode only from what Claude Code reports. A switch made while the assistant writes its next step can leave the
  re-issued call running on the allow. That window is one step, and at most `tokenMs`.
- **Edit-then-run is yours.** The classifier can allow an edit to a file that a command runs later. This happens when
  you allowed that command with your own `/permissions` rule (`Bash(bun test:*)`, say). Klyth does not stop that chain,
  so scope such rules with it in mind.
- **Your prompts.** A prompt counts as yours when Claude Code stamps it as written by the person or the SDK host. The
  stamp is the `origin` of the engine, not a guess from the text. These do not count:
  - A `/loop` or scheduled wakeup that the assistant wrote.
  - A task notification, a message of a peer session, or a prompt of a plugin.
  - A prompt that a hook refuses.

  Typed paths and URLs come from your prompts, never from a subagent's task.

## Managed policy

Klyth reads the managed policy settings of Claude Code when it loads the config.

- If the policy sets `sandbox.network.allowedDomains`, a provider whose host is not in the list is a config error.
- A provider whose host a `permissions.deny` rule names is a config error too. The rule can be `WebFetch`,
  `WebFetch(domain:<host>)`, or a wildcard such as `WebFetch(domain:*.example.com)`.
- Managed settings that Klyth cannot read are a config error, so no host goes unchecked. No managed settings is no
  error.
- A policy that only allows (`permissions.allow` rules, no deny) is not read as excluding other hosts.

The requests of Klyth do not go through WebFetch. They leave from the helper process, so Klyth checks the policy itself,
once, when it loads the config.

## Development

Generators, the smoke script and the test gates are in [CONTRIBUTING.md](../CONTRIBUTING.md).
