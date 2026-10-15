# Troubleshooting

Each Klyth error is one line: what failed, then the fix. In the messages below, `<p>` is a provider id, `N` is a
number, and `…` is text that varies. A message that names `klyth.json` shows the file Klyth read. This page writes it
with the default path `~/.claude/klyth.json`. That path follows `$CLAUDE_CONFIG_DIR` when you set that variable. Run
commands that start with `bun run` in the `klyth` folder.

## First look

`/klyth` shows the state: providers (kind, address, key state, approved), aliases, routed subagents and the timing and
tokens of recent steps. A `next:` line names the first fix. `claude --debug` logs one line for each routed step:

```text
klyth step <who> → <target> kind= http= effort= msgs= tools= bytes= ttfb= total= in= out= cache= wrote= reasoning= store=file|memory restored=<ids>/<blocks> finish=
```

## The `klyth step` debug line

- `ttfb` and `total` are the milliseconds to the first byte and for the whole step. `in` and `out` are tokens, and `in`
  includes the cached tokens. `cache` and `wrote` are the tokens read from, and written to, the prompt cache.
- `effort=max→medium` means the request asked for `max` and the effort map of the model applied `medium`. `thinking=N`
  is the number of signed thinking blocks that the step kept for the next one.
- `store=file` means the step used the response file of the session. `store=memory` means the host sent no session
  scope (for example, `CLAUDE_CONFIG_DIR` is not an absolute path), so the records stay in the memory of klythd.
- `restored=<ids>/<blocks>` counts the provider tool-call ids and the thinking or reasoning blocks that the step
  attached from the store.
- `note="thinking param left out: …"` means the signed blocks of a tool turn were missing, so that one request went
  without the `thinking` param ([Thinking](CONFIG.md#thinking)). Blocks are missing when another model or provider
  endpoint made the turn, or when the turn was cut before its blocks arrived. Blocks are also missing when klythd
  restarted after a step that ran from memory.
- `load` identifies one lifetime of klythd. Compare fingerprints only when `load` matches, because each load uses a
  private salt. `session`, `system`, `tools` and `params` fingerprint the outgoing session header (`-` means absent),
  the encoded system prompt, the tools and the other body params.
- `history` lists `index:hash` pairs for at most the first 16 and the last 16 encoded transcript items. Klyth does not
  detect a change in the omitted middle. `historyTotal` and `historyOmitted` count the full and the unsampled items.
  `firstMeta` and `firstBlocks` fingerprint the first item in the same way.
- `unavailable` means fingerprinting failed. It does not mean that Klyth withheld a request.

To compare a cache miss, run Claude Code with `--debug`. Capture the `klyth step` lines of a small routed conversation
and of one immediate resume, with no reload between them. Compare the fingerprints and the `cache` counters. Matching
samples do not prove that a provider kept or dropped its cache. Other debug lines can hold sensitive text, so do not
share a whole debug log.

## Response records

Each engine session keeps its response records in `<configDir>/klyth/responses/`, one file for each session.
[Thinking](CONFIG.md#thinking) says what the file holds and when Klyth removes it.

- **`klyth responses <session-hash> store=file records=N dropped=M bytes=B swept=K`** Klyth logs this line once, when a
  session file store opens. `<session-hash>` is eight hex digits of a hash of the session id. `records` counts the lines
  read, `dropped` counts the lines that did not parse or had the wrong shape, and `bytes` is the offset after the last
  whole line. `swept` counts the files that the retention sweep removed. The sweep runs once for each config directory
  in each klythd process.
- **`klyth responses: prefix changed at item i of n (<loop>, <purpose>)`** Klyth logs this line only when klythd started
  with `KLYTH_PREFIX_TRACE=1`, which is off by default because it digests every input item. The encoded input differs
  from the previous `step` request of the loop, first at item `i` of `n`. `<purpose>` is `step`, `classifier`,
  `compaction`, or `-` when unset. This is a cache-miss diagnostic, not a refusal.
- **`klyth responses: anchors off above 4096 messages (<loop>)`** On the `openai-responses` kind, the transcript is over
  4,096 messages (the most that the host gives klythd). Text-only turns no longer restore their reasoning, so the
  prompt cache may miss on them. Tool turns still restore it by call id.
- **`klyth: responses store unavailable (<code>): …`** Klyth could not open or write the response file, so it refuses
  the step and sends nothing. `<code>` is the system error. `ENOSPC` means the disk is full: free disk space. `EMFILE`
  means klythd has too many open files. `EACCES` means you cannot write the session file: fix its mode and owner.
  `ELOOP` means the session file is a symlink: replace it with a regular file. `EIO` means a write came up short.
  `closed` means the conversation that owned the step ended. The next step tries again. `not private` means that a
  privacy rule failed. `<configDir>/klyth` and `klyth/responses` must be 0700 directories that you own. No symlink may
  lie below `<configDir>` on that path. The session file must be mode 0600. Fix the mode and owner. The message also
  offers to trash the session file. That drops the stored blocks of the session and the original form of its klyth
  agent calls, so free disk space first.
- **`klyth: invalid session scope (<field>): set CLAUDE_CONFIG_DIR to an absolute path and restart`** The session scope
  from the host failed validation. `<field>` is `session`, `id`, `configDir` or `transcript`. For `session`, `id` or
  `transcript`, that setting may not be the cause.

## Completed-child resume cache seam

For the [resume workaround](CONFIG.md#prompt-cache), the debug line
`klyth cache-seam <id> pending= confirmed= headLF= containment= apply=<reason>` shows the outcome of each step.
`apply=moved` means Klyth moved each attested wrapper to its own delivery user turn in the outgoing copy. Any other
reason (`unattested`, `head`, `changed`, `prefix`, `delivery`, `wrapper`, `bounds` or `tail`) means Klyth left the
transcript unchanged. No seam line means Klyth kept no candidate. It does not prove that the host never changed its
opening. A `moved` line does not guarantee a provider cache hit.

The cache ledger behind the fix keeps at most 32 seams for each child, 64 openings, and 2 MiB of serialized payloads in
all. An opening holds at most 64 KiB, and a delivery and its observed wrapper hold at most 32 KiB each. Klyth checks the
completed prefix and the delivery messages with SHA-256, up to 4 MiB for each serialization and 4,096 messages. It
keeps only the digests. These cases pass through unchanged: main, a fork, an unknown or concurrent delivery, an
unmatched wrapper, a changed or compacted history, and an exhausted bound. A known compaction clears the ledger of that
loop. A reload discards the ledgers, but a resumed child keeps its moved opening, and Klyth restores it when the
child next speaks. The end of a session discards every ledger.

## Delivery recovery

The [delivery recovery aid](CONFIG.md#delivery-recovery-aid) is on by default for every valid Klyth config.
`compaction.deliveryRecovery: false` turns off new capture. The aid keeps the text of supported local `SendMessage`
calls apart from the host transcript. It does not fix every host delivery path, and it does not replay messages after a
crash.

- **`klyth: this SendMessage was not backed up (unsupported recipient/payload, journal unavailable or capacity reached)`**
  The send still runs, with its normal permission checks. Klyth warns at most three times for each engine session, so
  later silence is not proof of capture. Run `/klyth recovery` to see the actual records. Klyth does not support names,
  remote sessions and teammate processes: use an exact local id. Check the ownership of the private directory, its
  permissions and the free disk space. Do not remove existing evidence. Klyth never truncates larger text silently.

`/klyth recovery` lists the records of the current session by recipient. It labels each record with one observation:

| State | Meaning and action |
| --- | --- |
| `queued; possibly delivered` | Klyth saw a queue acknowledgment, not a history insertion. The original may have arrived already, so review the recipient before you restore. |
| `send outcome unknown; possibly never sent` | The backup exists, but Klyth saw no conclusive tool result. This is no evidence that the send was accepted or that its content was lost. |
| `send refused (audit evidence)` | The normal call reported a refusal. Klyth keeps the backup, but leaves it out of the pending-recovery count at startup, unless a restore that you requested has an uncertain outcome. A recovery grants no permission and does not replay the refused tool. |
| `restore outcome unknown; possibly delivered` | A restore claim exists without a completed receipt, so the append may have succeeded already. Klyth does not retry on its own. After a restart or resume, another manual restore needs your normal consent and your explicit consent to the duplicate risk. |
| `copy restored (original delivery unproven)` | Klyth appended a labeled context copy and recorded its new UUID. This does not prove the original delivery or the model consumption. Klyth refuses a second restore. |
| `dismissed (backup retained)` | You dismissed the record. Klyth keeps all backup bytes. |

**`klyth recovery: journal or restore state unavailable/changed; any append outcome may be unknown. No automatic retry. Review /klyth recovery after resume; existing evidence is retained.`**
Klyth logs this line when the files are inaccessible, corrupt or full, or when a confirmation went stale. It also logs
the line when a concurrent command changed the record. Inspect the record again before you decide. A missing receipt
does not make a retry safe.

`/klyth recovery show <id>` previews a record only in the UI. A restore always asks you. A headless call, a missing
answer or a cancel cannot append. A restore cannot cross sessions, respawn a stopped child, redirect a child record to
main, or forge the original sender. Backups, pending publication evidence and receipt files are private message
history, not a disposable cache. Klyth never evicts, expires or removes them on its own.

## Setup and the helper process

| Message | Cause and fix |
| --- | --- |
| `klyth: bun not found — install bun (https://bun.sh), then retry` | Klyth looks on `PATH` and in `~/.bun/bin`. |
| `klyth: klythd did not start (see the debug log); run /klyth reload, then retry` | klythd printed no ready line within 3 s. Run `bun klythd/main.ts` in the `klyth` folder to see why. |
| `klyth: klythd crashed twice; routed models paused until /klyth reload` | klythd crashed twice within one minute. Read the debug log and fix the cause. |
| `klyth: klythd did not answer (curl exit N); run /klyth reload, then retry` | The helper or its socket is gone. Klyth restarts a helper that exits with no answer and no crash, and resends the step once. This message means that did not help, or curl failed in a way that allows no resend. Make sure that `/usr/bin/curl` exists. |
| `klyth: klythd stopped during the step; retry` | The helper ended or crashed during the step. Klyth does not resend a step after a crash. |
| `klyth: klythd sent a reply klyth could not read (see the debug log); run /klyth reload, then retry` | The helper answered with something other than a stream of events. The debug log has its first line. |
| `klyth: klythd refused a call without its token; run /klyth reload` | The mod and the helper lost track of each other. |
| `klyth: N routed steps are already in flight; retry when one ends` | The helper handles 16 steps at once. |
| `klyth: internal error in klythd (see the debug log); retry` | This is a bug in klythd. The debug log has the first line of the error. |

A key command that never runs, or a `/klyth` line that says `not yet run`, is normal until the first routed step for an
approved provider. `/klyth` never runs the key command ([`auth`](CONFIG.md#providers)).

## The config file

| Message | Cause and fix |
| --- | --- |
| `klyth: routing off, config error: …` | Fix `~/.claude/klyth.json`, then run `/klyth reload`. `/klyth` lists every error. [CONFIG.md](CONFIG.md) explains each key. |
| `klyth · routing off: no ~/.claude/klyth.json` | Copy `example.klyth.json` there and edit it. |
| `klyth: can't switch to <arg>: config error, …` | This is the same error, seen from `/model`. The native model stays active. |
| `klyth: couldn't switch to <arg> (internal error; see the debug log). Native model unchanged` | This is a bug in the `/model` handling. Read the debug log, then retry. |
| `klyth: provider "<p>" is not declared (declared: …)`, `klyth: "<model>" is not declared under provider <p> (…)` and `klyth: "<arg>" is not a klyth alias or model` | The name does not match your file. Check the alias and the models of the provider. |
| `providers.<p>.auth: missing; run bun run auth login <p>, …` | Every provider needs `auth.command`, or `"auth": "none"` for a server that checks no key. |
| `providers.<p>.auth: "none" is not allowed on a bedrock provider; Bedrock needs a key` | Use `auth.command`. |
| `providers.<p>.apiKeyEnv: no longer read; …` and `providers.<p>.auth.env: not supported; …` | Keys come only from a command. Run `bun run auth login <p>`, and remove the old key. |
| `providers.<p>.baseUrl: must use https (plain http needs "allowHttp": true on the provider)` | Use https, or set `allowHttp`. |
| `providers.<p>.baseUrl: the host must be a DNS name …` | Klyth refuses `localhost`. Use `127.0.0.1` or a real host name. |
| `providers.<p>.<key>: unknown key` | The key is a typo, a key of another kind, or a key at the wrong level. `maxTokensParam` belongs under a model of the `openai` or `openai-responses` kind, not under a provider. |
| `…params.<key>: reserved; klyth sets it` | Remove the key. Klyth owns that body key. |
| `providers.<p>.baseUrl: <host> is not in the managed policy's sandbox.network.allowedDomains` and `… the managed policy denies WebFetch to <host>` | The policy of your organization excludes that host. Ask its admin, or use another provider. |
| `…: maxOutputTokens leaves no input budget inside contextWindow` | Lower `maxOutputTokens`, or raise `contextWindow`. |
| `classifier: …` and `classifier.<key>: …` | The `classifier` key is malformed. [Classifier](CONFIG.md#classifier) lists each line. |

## Restoring main's route

Klyth saves the route of main for each engine session. Before automatic compaction can run, Klyth checks the saved route
against the current alias target and the provider trust fingerprint.

- **`klyth: saved main route could not be restored (invalid record, changed model/provider/config, or unavailable store). No native/provider fallback; fix config and /klyth reload, or explicitly select /model <target> or /model native/sonnet`**
  Klyth refuses main routing and compaction. It does not choose another host or native inference. Fix the config and run
  `/klyth reload`. Or select `/model <target>` (with normal provider approval) or `/model native/sonnet`.
- **`klyth: native switch could not be saved; retry /model native/sonnet before restarting or the previous route may return`**
  Native is active in this process. Retry the native selection before you restart.

A session that never saved a route has no record, for example a session from an older Klyth version. Select
`/model <target>` again while idle, before you restart. This works with a large transcript. The selection warns you to
run `/compact`, but it sends no provider request. The 95% request guard still applies. A store write fails with a
visible error at the 4 MiB total limit of the public store. Klyth does not evict old sessions or remove approvals
silently.

## Keys and approval

| Message | Cause and fix |
| --- | --- |
| `klyth: <p> key helper failed (exit N): keychain locked, or no key stored? Run bun run auth login <p>` | Unlock the Keychain, or store the key. When the command prints why it failed, Klyth shows that line in place of this guess. |
| `klyth: <p> key helper did not finish (…); unlock the keychain or fix auth.command, then retry` | The command could not start, or it ran past 10 s. Run it by hand and fix it. |
| `klyth: <p> key helper printed no usable key (…); run bun run auth login <p>` | A key is 1 to 4096 visible ASCII characters with no spaces. |
| `klyth auth: storing <p> takes a N-byte security -i line, over its 4000-byte limit; nothing stored` | On macOS, `bun run auth` gives the Keychain one line through `security -i`, which runs the rest of a longer line as a command of its own. Klyth stores nothing, and the item already there stays. Keep a key that long in your own tool, and point `auth.command` at it. A ChatGPT sign-in that long cannot go in the Keychain yet: open an issue. |
| `klyth auth: providers.<p> is not in <path> (or the file is missing or not JSON); Run /klyth setup first` | The login ran with `--write-config`, but `klyth.json` has no such provider. |
| `klyth: provider <p> not approved; native model unchanged. Run /model <arg> again and choose Allow` and `klyth: provider <p> is not approved; run /model <alias> to approve it. The step was not sent` | Run `/model <alias>` and choose **Allow**. [Security](../README.md#security) says what an approval covers. |
| `klyth agent: provider <p> is not approved; use Agent for a native model` and `klyth agent: provider <p> is not approved; run /model <alias> once and choose Allow` | Run `/model <alias>` once and choose **Allow**. Then ask again. A subagent gets the second form, because only main can show the approval prompt. |
| `klyth: <p> not approved — run /model <alias> to approve it` | The helper did not learn of the approval. |
| `klyth: <p> rejected its key (HTTP 401); store a valid one with bun run auth login <p>, then retry` | The key is wrong or expired. For a ChatGPT sign-in, see [ChatGPT sign-in and plan usage](#chatgpt-sign-in-and-plan-usage). Run the matching sign-in command. Login cannot replace a sign-in made with another method. |
| `klyth: <p> HTTP 403: …; ask the <p> admin for access, or store another key with bun run auth login <p>` | The key may not have access to that route. |
| `klyth: <p> wants a key (HTTP 401) but auth is "none"; run bun run auth login <p> and set auth.command, then retry` | The server checks a key after all. Set `providers.<p>.auth` to the `command` line that the login prints (`--write-config` does this). A 403 from a keyless provider has the same fix. |
| `klyth: your key for <p> can't use <model>; allowed: …` | Pick an allowed model, or ask the admin of the gateway for access. |

A short-term key that stops working after a while needs a key command that mints a new key. `ttlSeconds` must be below
the life of the key ([`auth`](CONFIG.md#providers)).

An ordinary request that gets HTTP 401 or 403 drops its cached key. If the key came from the cache, Klyth runs the
helper once more and retries before any output, within the shared limit of ten sends. A key that Klyth just read gets no
second try. Compaction and guarded dispatch stay single-attempt, auth failures included.

## The provider and the network

- **Klyth resends a request after a brief provider failure.** When a request fails before the provider sends meaningful
  output, Klyth sends the same request again, up to 9 more times (10 attempts in all). No output reached the
  transcript, so no tool ran. A provider may still count a request that it began before it failed. Klyth resends after:
  - an HTTP 500, 502, 503, 504 or 529
  - a 507 whose text is Envoy's `exceeded request buffer limit while retrying upstream`
  - a 429 that comes with a `retry-after`
  - a connection that was refused or reset before any answer
  - on the Responses API, an HTTP 200 stream with a structured `server_error`, `overloaded_error`,
    `server_overloaded` or `overload` failure before meaningful output
  - the exact text-only error "Our servers are currently overloaded. Please try again later.", from any provider

  Other "busy" or "retry" text does not count, and a permanent or unknown error code prevents the retry. HTTP,
  connection and stream failures, and the one cached-key refresh, share the ten sends. Before each resend, Klyth waits
  a random time between zero and a ceiling that doubles from 1 s to 256 s. When the provider sends `retry-after`
  (seconds or a GMT date), Klyth waits that long first, then the random time. A `retry-after` over 8 s ends the step at
  once with the error. The time bound of the step (`timeoutMs`) limits every wait, and Esc during a wait ends the step.
  The transcript shows nothing of this. The debug log has one `klyth retry …` line for each resend, with the attempt
  number, the status or kind of failure, and the wait in milliseconds.
- **Klyth never resends:**
  - a 4xx other than that 429 (a 401 or 403 takes the key path above)
  - a ChatGPT plan code (`subscription_sharing_*` or `chatpass_*`, see
    [below](#chatgpt-sign-in-and-plan-usage))
  - any other 507
  - a connect timeout, a stall, a timeout of the whole step, a redirect, or a certificate, TLS or header fault
  - a malformed or unfinished stream, or a quota, authentication, policy or validation error
  - a transport cut after the headers
  - a stream error after text, reasoning, refusal or tool activity, including a tool start that the decoder has not
    yet exposed

  A resend that late could repeat text or run a tool twice. The usage of a successful reply describes only the final
  response, not the failed attempts or their possible charges.

When every attempt fails, the message keeps its usual text and adds the count, as in
`… HTTP 503: …; the provider failed after 10 attempts: retry, or pick another model`,
`… HTTP 429: …; rate limited after 10 attempts: wait, then retry` and
`klyth: <p> could not connect (…) after 10 attempts; check the network or VPN, then retry`. A stream failure reports
`response failed: … after 10 attempts; …`. No setting changes the attempts or the waits.

| Message | Cause and fix |
| --- | --- |
| `klyth: <p> could not connect within 15 s; check the network or VPN, then retry` and `klyth: <p> could not connect (…); check the network or VPN, then retry` | The address is not reachable. Check the VPN and `baseUrl`. |
| `klyth: <p> stalled (no data for N s); retry` | Nothing arrived for 600 s (less with a small `timeoutMs`). |
| `klyth: <p> timed out after N s; retry, or raise providers.<p>.timeoutMs` | The whole step ran past its bound. When the bound of the request itself was tighter, as for the [classifier](CONFIG.md#classifier), the text ends with `raise classifier.timeoutMs`. |
| `klyth: <p> answered with a redirect (HTTP N), which klyth does not follow; set providers.<p>.baseUrl to the URL it redirects to` | Put the final URL in `baseUrl`. |
| `klyth: <p> request failed (…); retry, or see the debug log` | This is a transport fault. |
| `klyth: <p> HTTP 429: …; rate limited: wait, then retry`, `… HTTP 5xx …; the provider failed: retry, or pick another model`, `… HTTP 404 …; check providers.<p>.baseUrl and the model id …` and `… HTTP N …; check the params of <model> in klyth.json` | The message of the provider follows the status code, and the fix follows that message. |
| `klyth: <p> refused the request under its content policy (HTTP N): …` | Rephrase the request, or use another model. |
| `klyth: <p> blocked the request at its gateway (HTTP N, "…"), before the API answered; …` | An edge rule or firewall rejected the request. Ask the platform team. |
| `klyth: <p> response failed: …; retry, or see the debug log` | The provider sent an error in the stream. A ChatGPT plan error ends with its own fix instead, as [below](#chatgpt-sign-in-and-plan-usage). |
| `klyth: <model> ended the step with no stop; retry` | The host-side assembler received no internal `stop` event from the helper. This differs from the decoder messages `the stream ended with no finish reason` and `the stream ended with no stop reason`. Check the helper and stream errors around it. |

The first step is slow on a self-hosted model, because the model reads the whole prompt once, with every tool
definition. Later steps may reuse a cache if the server supports it and keeps a matching prefix.

## ChatGPT sign-in and plan usage

This section is for a provider on [your ChatGPT plan](PROVIDERS.md#openai-with-your-chatgpt-plan). Each plan error ends
with its fix, whether it arrives as an HTTP status or in the stream as `klyth: <p> response failed: …; <the same fix>`.

- **The sign-in page shows `error_code: 3p_delegated_access_policy_denied`** This text comes from the OpenAI page, not
  from Klyth. A policy on your ChatGPT account, usually from a workspace admin, blocks third-party apps, so
  `login --chatgpt` cannot finish. Stop it with Ctrl-C. Klyth stored nothing. Ask the admin to allow the app
  connection, or use an allowed API-key route. Another sign-in method does not bypass this policy.
- **`klyth auth: export prints your ChatGPT refresh token; pipe it: bun run auth export <p> | ssh <host> 'cd <klyth-checkout> && bun run auth login <p>'`**
  `export` does not print to a terminal. Pipe it as the message shows.
- To see a helper message in full, run `bun run auth token <p> > /dev/null`. The access token is the only thing that
  this command prints on stdout, so the redirect keeps it off your screen.

| Message | Cause and fix |
| --- | --- |
| `klyth: <p> HTTP 429: …; your ChatGPT plan's usage limit for klyth is reached; wait for it to reset, or raise it in ChatGPT settings` | You used up the usage limit for Klyth that you set in your ChatGPT settings. |
| `klyth: <p> HTTP 403: …; this ChatGPT plan cannot be used in other apps; use an API key (bun run auth login <p>, kind openai or openai-responses)` | OpenAI does not let the plan of this account run in other apps. Run `bun run auth logout <p>` first, because plain `login` refuses to replace a sign-in. Or give the API-key provider its own id. |
| `klyth: <p> HTTP 401: …; sign in again with bun run auth login <p> --chatgpt` | OpenAI no longer accepts the sign-in. |
| `klyth: <p> HTTP 400: …; this model or route is not available on ChatGPT plan usage; pick a model from bun run auth login <p> --chatgpt's list` | Login prints the models on your plan after it signs in. |
| `klyth: <p> HTTP 400: …; ChatGPT plan usage does not support an input, tool or param of this request; set the model's vision to false, or drop the one the message names` | Plan usage refuses some inputs, such as images, and some params. Set `"vision": false` on the model, or remove the param that the message names. |
| `klyth: <p> HTTP 503: …; ChatGPT plan usage is unavailable for this account right now; retry later, or use an API key` | OpenAI says that plan usage is down for this account. |
| `klyth: <p> key helper failed (exit 3): the ChatGPT sign-in expired or was revoked; run bun run auth login <p> --chatgpt` | OpenAI refused the refresh. The cause may be expiry, revocation, an account policy, or another copy that rotated the token ([one sign-in per machine](PROVIDERS.md#openai-with-your-chatgpt-plan)). The helper cannot infer a fixed authorization lifetime from this error. Plain `login` refuses to replace a sign-in. |
| `klyth: <p> key helper failed (exit 4): ChatGPT refuses a refresh until <time>; retry then` | The access token ran out, and OpenAI does not allow a refresh yet. |
| `klyth: <p> key helper failed (exit 1): another klyth refresh is running (lock <p>.lock in ~/.cache/klyth); retry` | Another Klyth process was refreshing the sign-in. The next refresh takes over a lock that is 30 s old. If the line keeps coming back while no Klyth refresh runs, trash that file. While a refresh runs, `bun run auth export <p>` stops with the same `klyth auth:` line. |
| `klyth: <p> key helper failed (exit 1): storing <p> takes a N-byte security -i line, over its 4000-byte limit; nothing stored` | The refresh worked, but the new sign-in is too long for the Keychain ([above](#keys-and-approval)). The stored sign-in stays, and its refresh token is used up, so the next refresh fails with exit 3. Open an issue. |
| `klyth: <p> key helper failed (exit 1): no ChatGPT sign-in readable for <p> in the … (locked, or none stored); run bun run auth login <p> --chatgpt` | Unlock the keyring, or sign in. |
| `klyth auth: the sign-in did not complete within 5 minutes; run login again` | Finish the sign-in in time. |
| `klyth auth: the pasted URL's state does not match this sign-in; run login again` | The URL that you pasted came from an earlier attempt, or it is not a URL. Each login prints a new URL. |
| `klyth auth: ChatGPT plan usage was not granted; run login again and allow klyth to use your plan` | You completed the sign-in page without allowing Klyth to use your plan. Klyth stored nothing. |
| `klyth auth: ChatGPT refused the sign-in (<error>: <description>)` | The words of OpenAI follow. If a workspace admin controls third-party apps, ask the admin, or use an API key. |
| `klyth auth: ChatGPT's ID token failed its … check; nothing stored; run login again` | The sign-in answer did not match this login. |
| `klyth auth: the sign-in changed while it was written (a refresh ran), so the copy sent is stale; <p> stays in the …; export again` | A refresh rotated the sign-in while `export` wrote it, so the other machine got a copy that OpenAI refuses. The newer sign-in stays here. `login` on the other machine replaces the stale copy. |
| `klyth auth: <p> holds a ChatGPT sign-in; run logout first, or login --chatgpt` | Plain `login` stores an API key and does not replace a sign-in. |
| `klyth auth: selected provider does not match the official ChatGPT backend; Run /klyth setup first` | With `--chatgpt --write-config`, the provider needs `baseUrl` `https://api.openai.com/v1` and kind `openai-responses`. |

## Context size

| Message | Cause and fix |
| --- | --- |
| `klyth: context ~Nk exceeds <target>'s 95% safety threshold (…) of its Nk configured input budget; run /klyth compact between turns` | [CONFIG.md](CONFIG.md#models) explains the budget. |
| `klyth: existing context ~Nk tokens is large for <target>'s Nk input budget; run /compact before continuing. Normal requests still enforce the 95% safety threshold` | `/model` shows this warning, and the selection still succeeds. It sends no provider request and does not compact automatically. |
| `klyth: tool schemas alone take ~Nk of <target>'s Nk input budget; set "tools": false on the model or use a larger one` | The tool definitions take more than half of the input budget of the model. |

## Which subagents run on an alias

- `mcp__klyth__agent` starts a subagent on the alias that the call names. Klyth turns the call into an `Agent` call
  before Claude Code runs it. This is the same for main on Claude, main on an alias, and a subagent on an alias. Claude
  Code then runs, shows and reports the subagent as its own. The new subagent belongs to the one that asked, runs in its
  permission mode and reports back to it.
- A subagent does not get `mcp__klyth__agent` when its type cannot call `Agent` (Explore and Plan) or its definition
  leaves the tool out. The tools of a routed subagent never exceed the tools of its caller.
- Your `/permissions` rules for `Agent` govern translated calls. On main on Claude, a deny or ask rule for
  `mcp__klyth__agent` still applies, and so does an ask from a plugin hook on it. Klyth leaves the call untranslated,
  and Claude Code checks it as before. A `PreToolUse` hook that matches `mcp__klyth__agent` does not see a translated call, so match `Agent` there. A translated
  call and a native `Agent` fork get no automatic Klyth approval. In auto mode, a refused task gets a review and an
  exact one-shot retry only when `classifier.tools` is `"all"`. Otherwise use a scoped permission rule or switch modes.
  Deny rules, ask rules, hooks and organization ceilings keep precedence. A permission refusal never falls back to a
  native model.
- The `effort` of the call applies first, then the effort of the agent file, then the effort of your session.
  `isolation: "worktree"` works in the worktree that Claude Code makes. The subagent stays native if Claude Code makes
  none.
- A plain `Agent` call follows its parent. While main is on an alias, these run on that alias:
  - an `Agent` call with no `model`
  - a custom agent whose file says `model: inherit` or has no `model`
  - a subagent that a routed subagent started, unless that routed subagent works or worked in a worktree
- These stay native:
  - a call that names a model or a `cwd`
  - an agent file with its own `model`
  - a teammate and a workflow agent
  - a custom agent whose definition Klyth cannot read (a plugin loaded with `--plugin-dir`, an `--agents` agent or an
    SDK agent), or finds in two files
  - a built-in type that two agent files name
  - `comment-thread-analyst`, which builds its prompt from the thread
- A built-in type runs on the prompt that Klyth wrote for it, and `claude` runs on the main prompt. One agent file with
  a `name:` equal to the type (for example `name: Explore`) replaces that prompt, with its `model`, `isolation` and
  `tools`. Two such files leave the type native.
- Klyth finds an agent by the `name:` in its file, in `.claude/agents`, `~/.claude/agents` and installed plugins. In the
  first two, Claude Code needs both `name:` and `description:`, and it skips a file without either. Klyth skips it too,
  and `/klyth` says so. A plugin agent file needs neither field. `/klyth` also lists each built-in type that runs on an
  agent file, and each file that Klyth cannot read.
- `mcp__klyth__agent` reads `subagent_type` as Claude Code reads an `Agent` call. Another spelling of a known type runs
  as that type, so `explore` runs as `Explore`. A custom type with no definition that Klyth reads runs as
  `general-purpose`, and `/klyth` notes the fallback. Klyth refuses:
  - a spelling that matches two agent types when it ignores case
  - a type that two files name
  - a built-in type whose one agent file Klyth cannot read
  - `comment-thread-analyst`
  - an isolation other than a worktree
  - a start from a subagent that works in a worktree
- Forks work only where Claude Code offers them. Elsewhere, `Agent` says that the fork type is not found. Klyth applies
  the fork rules to every spelling of `fork` that Claude Code accepts (`Fork`, `FORK`, `for_k`).
- A fork runs on the alias of its parent, or Klyth refuses it. A fork carries the whole conversation of its parent. So
  under a routed parent, a fork never runs natively and never runs on another alias. A fork of a native parent stays
  native. `subagent_type: "fork"` through `mcp__klyth__agent` runs on the model of its caller: name that alias or none.
- A fork gets the prompt and the effort of its parent. Its tools never exceed the tools of its parent, and the usual
  spawn depth applies. Claude Code offers a fork no `SubagentHandback`, and Klyth offers it none. The final message of a
  fork is its report.
- A fork gets the history of its parent up to and including the turn whose call started it. Claude Code saves a fork of
  main without the history of main, so Klyth rebuilds that history from main, cut at that call. Klyth does not send a
  fork that it cannot rebuild. A fork that resumes after a compaction of main, or after a hooks reload once main
  compacted, cannot be rebuilt. It fails with the inherited-history line under
  [Routing and subagents](#routing-and-subagents).
- Klyth refuses a fork under a routed parent when it cannot run the fork there:
  - a fork that a subagent started in a worktree
  - a fork that asks for isolation or sets a `cwd`
  - a fork that is a teammate, a workflow agent or the spawn of another plugin
  - a fork whose parent route Klyth cannot read

  If the first step of a fork comes before Klyth claims it, Klyth hands the step back and does not run it natively.
- Claude Code 2.1.294 gives a subagent `SubagentHandback` only in auto permission mode. Elsewhere, the final text of a
  subagent is its report. Klyth offers the tool only when the engine reminder that it delivers through the tool is in
  the transcript of the subagent. Klyth stops offering it after the engine refuses a call of it. A subagent on a model
  with `tools: false` gets no tool.

## Routing and subagents

| Message | Cause and fix |
| --- | --- |
| `klyth: <target> is not available (…); the step was not sent. Fix ~/.claude/klyth.json, run /klyth reload, or pick another model` and `klyth: <target> is not configured in this session; run /klyth reload` | The config changed during a routed turn. |
| `klyth: the transcript of <who> is unreadable (…); the step was not sent; retry` and `klyth: internal error on <target>; …` | Retry, or look in the debug log. |
| `klyth: <tool> is not available to the <type> subagent` | A routed Explore or Plan asked for a tool that its type lacks, such as `Write`. The guard denied the call. |
| `klyth: could not check <tool> for this subagent, so it was denied; retry, or see the debug log` | Klyth could not check the call. |
| `The server-side auto mode classifier gave no verdict for <tool> …` | This message comes from Claude Code, for a routed turn that has no native classifier verdict. It is not the actual block of a native classifier, and a retry alone grants nothing. Use the opt-in [classifier](CONFIG.md#classifier) for eligible actions. Delegated Agent tasks, including translated Klyth calls and routed forks, need `classifier.tools` `"all"`. Routing does not approve them. Explicit permission rules keep precedence. Otherwise recover by hand, or switch modes (Shift+Tab). Writes to protected roots and opaque execution there stay ineligible, whatever the classifier coverage. |
| `klyth: left <alias> (<provider>/<model>)` | This is not an error. You picked a native model, so main is native. `/model <alias>` returns to the alias. |
| `klyth agent: unavailable (…); use Agent` | Klyth has no valid config. Fix `~/.claude/klyth.json` and run `/klyth reload`, or use the native `Agent` tool. |
| `klyth agent: model is required; valid: …` | The call named no model. In a routed conversation, the line adds that a fork may leave the model out. |
| `klyth agent: unknown model "…"; valid: …` | The call named a model that is not in the list. |
| `klyth agent: unsupported parameter(s) …; use Agent for them`, `klyth agent: invalid input: …` and `klyth agent: isolation "…" is not available through klyth; …` | Use only the supported parameters: `description`, `prompt`, `subagent_type`, `model`, `effort`, `name`, `isolation` set to `"worktree"`, and `run_in_background`. |
| `klyth agent: not available from a native subagent or from inside a spawn; use Agent here` | A subagent on a native model starts subagents with `Agent`. A subagent on an alias uses `mcp__klyth__agent`. |
| `klyth agent: not offered to the <type> subagent; use a tool it has` and `klyth agent: not offered to main in this step; use a tool it has` | The step did not offer the Klyth agent tool. The type cannot call `Agent` (Explore and Plan), the definition leaves the tool out, or the tool list has no `Agent`. |
| `klyth agent: the subagent on <alias> was still starting, so this step was not run; retry` | Starting the subagent took longer than the 5 s that Klyth waits. Klyth handed its step back and did not run it on the model of Claude Code. |
| `klyth: could not check this Agent call, so it was denied; retry, or see the debug log` | The own check of Klyth failed. |
| `klyth agent: <alias> is not a native alias the Agent tool takes (…); use one of those, or a klyth alias` | A subagent can name a native model only as `opus`, `sonnet`, `haiku` or `fable`. |
| `klyth agent: <type> <reason>, so klyth cannot run it on <alias>; use another subagent_type or a native model` | Klyth cannot reproduce that agent type on an alias. See [Which subagents run on an alias](#which-subagents-run-on-an-alias). `claude --debug` logs the reason. |
| `klyth agent: a fork runs on its parent's model, and this conversation is native; to fork natively use Agent` | A native conversation asked Klyth for a fork. The fork stays native with `Agent`. |
| `klyth agent: a fork runs on its parent's model (<alias>), not on <model>; omit model, or name <alias>` | A routed conversation asked for a fork on another model. |
| `klyth agent: a fork cannot be isolated through klyth; omit isolation` | A fork works in the directory of its parent. |
| `klyth agent: this fork could not be made an Agent call, so it did not start (see the debug log); retry, or fork with Agent` | Call `Agent` with `subagent_type: "fork"`. |
| `klyth: this fork was refused: <reason>; a fork runs only on its parent's model, never natively under a routed parent` | The fork could not run on the alias of its parent, so Klyth stopped it. The reason names one of the refusals under [Which subagents run on an alias](#which-subagents-run-on-an-alias), or a request for another alias. If the fork had already started, this line is its report. Fork without those options, or use another `subagent_type`. |
| `klyth: this fork of a conversation on <alias> was still being claimed, so its step was not run natively; retry` | Claiming the fork took longer than the 5 s that Klyth waits. Klyth did not run the step natively. |
| `klyth: the route of the parent of this fork cannot be read; the step was not sent; retry` | A routed fork needs the prompt of its parent, and Klyth could not read the route of the parent. |
| `klyth: this fork's inherited history could not be read, so the step was not sent; use another subagent_type than fork` | Klyth could not rebuild the history of the fork. The turn whose call started the fork is gone from the history of its parent (a compaction). Or the route of the fork has no record of that call (a fork from before an upgrade). Or the joined messages do not pair each tool call with its result. Klyth does not send a request without that history, because the answer would ignore the conversation. |
| `klyth agent: subagent_type "<type>" matches more than one agent type (…); name one of them exactly` | Two agent types differ only in case. |
| `klyth agent: the engine started <type> as <other>, so klyth did not run it on <alias>; retry` | A hook changed the type of the subagent. The subagent hands this back as its report. |
| `klyth agent: <reason>, so klyth did not run the subagent on <alias>; retry, or use a native model` | Claude Code started the subagent on another model, a hook changed its type, or Claude Code made no worktree for an isolated one. The subagent hands this back as its report. |
| `klyth agent: <alias> is not configured any more, so the subagent did not start; …` | The config changed between the call and the start of its subagent. Fix `~/.claude/klyth.json`. |
| `klyth agent: run_in_background false needs a conversation that klyth routes; omit it, and the subagent runs in the background` | The call reached the tool untranslated, for example because its provider was not approved yet. Such a call runs in the background only. Omit `run_in_background`, or approve the provider and call again. |
| `klyth agent: effort cannot be set for a native model through klyth; …` | Omit `effort` for a native model. |
| `klyth agent: isolation "worktree" needs a git work tree, and … is not inside one; omit isolation`, `… needs a commit to start from …` and `klyth agent: git worktree add failed: …` | Run in a git repository with a commit, or omit `isolation`. |
| `klyth agent: the subagent did not start; retry, or use Agent` and `klyth agent: internal error (see the debug log); use Agent` | Retry, or use the native Agent tool. |
| `klyth: kept worktree <path> (branch <b>) of subagent <who>: <why>; merge <b> or remove the worktree` | The subagent left changes there, or Klyth found no `trash` command to move the worktree with. Klyth never removes a worktree that has changes. It moves a clean worktree to the Trash. |

## The auto mode classifier

These lines appear only when `klyth.json` has a `classifier` key. [Classifier](CONFIG.md#classifier) says what the
classifier is and states its limits. Each line comes after Claude Code refuses the action, and it shows under the name
of Klyth (`klyth: classifier: …`). An allow shows nothing, as in Claude Code, and appears only in the debug log
(`claude --debug`). The assistant issues the action again, and it runs once. If it does not run, the allow lapses after
`tokenMs`.

The trigger is the exact `Classifier unavailable` refusal of the engine for a routed call: no native classifier
verdict was available. Klyth does not override the actual block of a native classifier. An ask, a missing verdict or a
backend failure from Klyth leaves the refusal in place, and another attempt alone is not an approval. An eligible
refusal first offers a native pane. The pane shows the actor, the tool and the complete escaped action, with **Allow
once**, **Deny** and an 8-second countdown. Allow once approves only that exact action. Only a visible timeout of the
pane delegates to the classifier. The classifier must block risky or uncertain actions, even when the conversation
authorizes them. Klyth does not review the report of a finished subagent.

The countdown starts only when Klyth places and shows the pane. At least 9,500 ms of the hook budget must remain before
and after the pane opens. An unasked pane may not fit on a narrow terminal (normally below 144 columns), and focus does
not force placement. An unplaced pane closes at once, and Klyth keeps no background review queue. The countdown sends no
prompts or provider requests. One question is open for each session. Identical requests share its deadline, and Klyth
blocks distinct simultaneous requests.

| Message | Cause and fix |
| --- | --- |
| `approval unplaced`, `approval budget` or `approval busy` in a classifier skip line | Klyth could not show the pane, fewer than 9,500 ms remained before or after it opened, or another distinct approval was active. The action stays blocked, and no hidden timeout, queued review or model request follows. Use normal mode or manual approval. An unasked pane normally needs at least 144 terminal columns. |
| `approval deny`, `approval cancelled` or `approval stale` | You chose Deny, you closed the pane with Esc, or a change to the action, session, mode or policy ended the approval. None of these starts the classifier. |
| `the complete action cannot be safely displayed` | The review details would be unsafe, or too long to show in full. Klyth approves nothing from a truncated or masked summary. Use normal mode or manual approval. |
| `klyth: classifier: did not allow <tool>: <reason>` | The classifier answered "ask", so the refusal stands. Make the change yourself, allow the action in `/permissions`, or switch modes (Shift+Tab). Klyth does not classify the same action again in this turn. |
| `klyth: classifier: Bash is not classified; allow it with a /permissions rule or switch modes (Shift+Tab)` and `klyth: classifier: Agent is not classified; allow it with a /permissions rule or switch modes (Shift+Tab)` | The default `classifier.tools` is `"bounded"`, which classifies neither Bash nor a subagent spawn. Set it to `"all"` to classify them, after you read what that leaves to the classifier model ([Classifier](CONFIG.md#classifier)). |
| `klyth: classifier: WebFetch is not classified with classifier.context "fork"; allow it with a /permissions rule or switch modes (Shift+Tab)` | With `classifier.tools` `"bounded"`, the fork context never classifies WebFetch. Allow it in `/permissions`, set `classifier.context` to `"fresh"` (which classifies a URL that you typed), or set `classifier.tools` to `"all"`. |

Plan and memory Markdown documents in the [recognised artifact roots](CONFIG.md#classifier) can reach review. This does
not exempt settings, nested protected names, secret paths, symlink escapes or the installed plugin root.

Each line below means that Klyth did not ask the classifier, and the refusal stands. Unless the entry says otherwise, do
the action yourself, allow it in `/permissions`, or switch modes (Shift+Tab). Klyth says each line once for each action
in each turn.

| Message | Cause and fix |
| --- | --- |
| `klyth: classifier: <tool> was not classified: the action in this working directory is …` | Opaque execution (`Bash`, `Monitor`, unknown tools and MCP calls) is ineligible in your home directory or above it and in protected directories. Native inspection and search, message coordination and Agent tasks can still be classified. |
| `klyth: classifier: <tool> was not classified: klyth classifies Edit, Write, NotebookEdit and WebFetch only` | The tool is any other tool, with `classifier.tools` `"bounded"`. Set it to `"all"` to classify every tool. |
| `klyth: classifier: <tool> was not classified: it touches a protected path (<match>)` | The classifier never classifies that path, typed or not. Edit it yourself. [Limits](CONFIG.md#classifier) says which protected paths Klyth still classifies. |
| `klyth: classifier: <tool> was not classified: it writes in a working directory that is a protected path (<match>)` | The classifier never grants writes there. If `<match>` is the installed Klyth checkout, use `isolation: "worktree"` on the agent call for edits and tests. Otherwise recover with your own permission rules or another mode. Do not disable the guard of the classifier. |
| `klyth: classifier: <tool> was not classified: it writes outside <dir>` | The path is outside the directory where Claude Code runs, and you did not type it. Work inside the directory, or type the exact absolute path in your own prompt. |
| `klyth: classifier: <tool> was not classified: it goes through a symbolic link` | A link lies somewhere on the path. Klyth follows a link only at the first folder of a path that you typed (`/tmp` on macOS). Use the real path. |
| `klyth: classifier: <tool> was not classified: its path starts with ~, which klyth does not expand`, `klyth: classifier: <tool> was not classified: its path holds a .. segment, which klyth does not follow`, `klyth: classifier: <tool> was not classified: the path is not absolute`, `klyth: classifier: <tool> was not classified: its path could not be resolved`, `klyth: classifier: <tool> was not classified: it names no usable file path` and `klyth: classifier: <tool> was not classified: the action has no input to classify` | The path of the call starts with `~`, holds `..`, is relative, or is empty. The path also fails when it holds a control character, or when Klyth cannot place it (a link that leads nowhere, say). Ask for a plain absolute path inside the directory. |
| `klyth: classifier: <tool> was not classified: it fetches a URL you did not type` | With `classifier.tools` `"bounded"`: type the exact URL in your own prompt, then ask again. With `"all"`, Klyth classifies any URL. |
| `klyth: classifier: <tool> was not classified: it names a protected path (<match>)` | This applies with `classifier.tools` `"all"` to a tool with no path (a command or an MCP call, but not an `Agent` task). Its input names a path that Klyth never classifies, or the `core.hooksPath` of git. [Limits](CONFIG.md#classifier) says which worktree paths are exempt. Run the action yourself, or allow it in `/permissions`. |
| `klyth: classifier: <tool> was not classified: it holds a .., which could climb out of this worktree into a protected path (<folder>)` | This applies with `classifier.tools` `"all"` in a worktree inside a folder that Klyth guards. The input of a tool with no path holds `..` in some spelling, which could reach the code that Klyth runs. Write the command with paths inside the worktree, or run it yourself. |
| `klyth: classifier: <tool> was not classified: it removes the root or the home directory, which klyth never allows` | With `classifier.tools` `"all"`, Klyth never classifies a Bash command that removes the root or your home directory recursively. Run it yourself if you mean it. |
| `klyth: classifier: <tool> was not classified: your auto mode settings could not be read` | The classifier adds your `autoMode` policy to its rules and cannot work without it, so it asked nothing. Retry in a new turn, or fix the settings that Klyth reads (user, `--settings`, managed). |
| `klyth: classifier: <tool> was not classified: the action is too large to classify (<n> KiB)` | Klyth never classifies an action over 8 KiB (16 KiB for an `Agent` task). Ask for smaller edits. |
| `klyth: classifier: <tool> was not classified: the subagent's task is too large to classify (<n> KiB)` | Klyth counts the task of a subagent that it vetted at the spawn as one whole request. It does not cut a task over 16 KiB, so it classifies nothing that the subagent does. Start the subagent with a shorter task. |
| `klyth: classifier: <tool> was not classified: the working directory could not be resolved` | Klyth could not place the directory that Claude Code reported. Start Claude Code in an existing folder. |
| `klyth: classifier: <tool> was not classified: <n> actions were classified this turn (classifier.maxPerTurn)` and `klyth: classifier: <tool> was not classified: <n> classifier requests are in flight` | The turn used its `maxPerTurn`, or 4 classifier requests are already running. Raise `classifier.maxPerTurn`, or retry in a new turn. |
| `klyth: classifier: <tool> was not classified: provider <p> is not approved; run /model <name> once to approve it` | Run the `/model` command that the line names and approve the provider. Then switch back with `/model`. |
| `klyth: classifier: <tool> was not classified: the classifier request failed (<what>)` | The request of the classifier model ended in an error: a timeout, a provider error, or a `classifier.model` that the config no longer has. `<what>` is the first line of the error, or `no answer in <n> s` when Klyth cut a request that was still unanswered 5 s past `classifier.timeoutMs`. Raise `classifier.timeoutMs` for a timeout, fix `classifier.model`, or retry in a new turn. |
| `klyth: classifier: <tool> was not classified: the classifier answered no verdict (<what>)` | The reply was not one JSON object with a verdict of `allow` or `ask` and a reason. `<what>` says what was wrong. Retry in a new turn, or name a more capable `classifier.model`. In the fork context, a reply that calls a tool is no verdict. The same holds for a second `SubagentHandback` call. |
| `klyth: classifier: <tool> was not classified: the conversation could not be read` | Klyth could not read the transcript that it shows the classifier. Retry in a new turn. |
| `klyth: classifier: <tool> was not classified: the loop's last request is not known` | The fork context sends the last request of the loop again, and Klyth keeps that request in memory only. The hooks of the mod reloaded since the last step of the loop. The next routed step records the request. Retry then. |
| `klyth: classifier: <tool> was not classified: this fork's inherited history could not be rebuilt` | Klyth could not rebuild the history of a routed fork for the fork context. Retry in a new turn. |
| `klyth: classifier: <tool> was not classified: the conversation does not make a well-formed request` | In the fork context, the tool calls and results do not pair up (a call with no result in the turn after it, say). The provider would refuse such a request. Retry in a new turn, or set `classifier.context` to `"fresh"`. |
| `klyth: classifier: <tool> was not classified: the conversation (~<n> tokens) exceeds <target>'s <m> input budget` | In the fork context, the classifier reads the whole conversation, and it no longer fits the model. Run `/compact`, or set `classifier.context` to `"fresh"`. |

`/klyth` shows `classifier: <model> · <context> context · <tools> tools · <n> allowed · <m> asked · <k> not classified`
(`<context>` is `fresh` or `fork`, `<tools>` is `bounded` or `all`). A skipped action adds
`last ineligible (<tool>: <reason>)`. It does not turn the classifier off for the directory. `claude --debug` logs
`klyth classifier <who> <tool> <id>: …` for each refusal that the classifier meets. The line says what the classifier
decided, or why it did not classify, and how long it took. Klyth also logs `klyth classifier: tokens dropped (<signal>)`
when it drops allows. The request of the classifier shows as a `klyth step classifier:<who>` line (see
[The `klyth step` debug line](#the-klyth-step-debug-line)).

## Notes in `/klyth`

| Note | Cause and fix |
| --- | --- |
| `schemas: generated on <old> · engine <new> · regenerate with bun scripts/gen-schemas.ts` | The Claude Code version changed. Klyth still runs. It sends the tools whose schemas it lacks with a permissive schema. |
| `tools dropped (cap N)` | The `maxTools` of the provider cut some tools. Raise `maxTools`, or load fewer MCP tools. |
| `tools dropped (name over 64 chars)` | The tool-name rule of the API (64 characters of letters, digits, `_` and `-`) refuses those names. Rename the tool in its MCP server. |

## What differs from native

- **Caching.** Every step resends the whole context. [Prompt cache](CONFIG.md#prompt-cache) and
  [Providers](CONFIG.md#providers) describe the cache marks and `sessionHeader`. Neither guarantees a cache hit or
  retention.
- **Reasoning.** It shows live, and Klyth does not save it in the transcript. Where an endpoint hides it, nothing shows
  while the model thinks ([Thinking](CONFIG.md#thinking)).
- **Tools.** A routed model sees the same tools as the session, less the main-only tools for a subagent. Klyth does not
  send an MCP tool that ToolSearch has not loaded.
- **Content.** Klyth sends a document as a placeholder, and an image only to a model with `vision`.
- **The picker and labels.** The `/model` picker does not list aliases. There is no "answered by" label for each
  message. `/cost` prices routed tokens as an unknown model.
- **Tool calls.** The `openai` Chat Completions decoder rejects late fragments for a call that it already closed. Klyth
  does not support providers that require a fixed tool-call id shape.

## Routed compaction recovery

Compaction on a routed loop uses its approved provider, not the native summarizer. [Compaction](CONFIG.md#compaction)
says how it works. [Host compaction window](CONFIG.md#host-compaction-window) says what the default host window does.

- Klyth saves the route of main and restores it at startup and resume, before automatic compaction can run. A changed
  alias, a changed provider or a missing config refuses routing until you select `/model <target>` again, or fix the
  config and run `/klyth reload`. See [Restoring main's route](#restoring-mains-route).
- Each debug line below starts with **`klyth host compaction window: `**. It explains a lost ownership or a failed
  write. When a line says to restart Claude Code, restart it. Klyth never restores an environment change that another
  program made.
  - `unfinished environment mutation; baseline retained; restart Claude Code to recover`
  - `ownership changed while releasing; environment left alone`
  - `environment changed independently; ownership released without restoration`
  - `ownership changed during reload; environment left alone`
  - `existing environment value exceeds the ownership bound; left alone`
  - `environment changed before mutation; left alone`
  - `environment write failed; no successful policy change reported`
  - `ownership changed after environment write; restart Claude Code to recover`
  - `environment or ownership state unavailable; baseline retained when reserved; retry /klyth reload or restart Claude Code`
  - `handoff unavailable or changed; policy left unchanged; restart Claude Code to recover`
- `/klyth compact [instructions]` queues the built-in `/compact` command. The wrapper first reports the scheduling, and
  core later reports the completion or an actionable skip. Scheduling is not proof of success, so do not issue a second
  `/compact` only because `/klyth compact` reports that it queued work. A real change to the history, configuration or
  permission state of the recipient can make a queued request stale. Its message names the cause.
- Main-loop routed compaction shows its progress in the bottom status bar, in place of the route status. Only chunked
  recovery has a bar, and completed calls fill it. The labels are "large-history summary", "part N of M" and
  "combining summaries".
- Klyth saves every accepted complete final summary before the installation checks, in
  `<Claude config directory>/klyth/compactions/<engine session id>/<unique id>.json`. The notice gives the exact path
  on success and on the rejection of a stale result. The private JSON holds the complete summary, the route and session
  metadata, and at most 24,000 characters of recent context, not the full conversation. It is an immutable
  `draft-not-installed` recovery artifact, not an installation receipt or a permission grant. Read or copy the summary
  as context for a fresh session. Klyth never installs it on its own after a stale rejection. Directories are mode 0700
  and files are mode 0600. Klyth refuses symlinked storage paths and applies no automated removal or retention policy.
  If storage fails, compaction keeps the active history and reports the checks to make before you retry.
- The debug log names the path that ran. `klyth compact <who>: append-only prefix request` is the normal path.
  `klyth compact <who>: uncached chunk recovery (normal prefix exceeds configured input budget)` is the fallback. The
  lines `klyth compact <who>: installation rejected: …`, `klyth compact <who>: failed (…)` and
  `klyth compact <who>: preflight source history mismatch (…)` name the failed condition.
- A rejection names the failed condition. For message rows, it names only the index, the role and the names of the
  changed fields. It never prints conversation contents.
- A skipped compaction leaves the history and the cache-resume attestations unchanged. Check the debug log for provider
  failures and for input or output bounds. Wait for the active turn to end, or choose a larger configured model. Waiting
  helps an unfinished tool, but repeating commands cannot fix a malformed history.
- No routed failure falls back to native inference. A summary grants no permission. A shorter history or a changed
  prefix revokes stale estimates, cache state, queued work and permissions. Rewinding the transcript does not restore
  edited files.

These messages report the outcome of a compaction:

| Message | Cause and fix |
| --- | --- |
| `klyth: compaction skipped: <why>; history kept; resolve this cause before retrying /klyth compact` | Klyth kept the history. `<why>` names the cause. Examples: an unfinished or unmatched tool call, no older history to summarize, a provider that is not approved, a too small summarization input budget. |
| `klyth: compaction failed safely; history kept; retry /klyth compact` | Klyth kept the history. |
| `Compaction could not run (<detail>); history kept; retry /klyth compact between turns.` | `/klyth compact` could not start. Retry when the session is idle. |
| `Compaction queued for main to become idle; no need to issue another /compact command.` | `/klyth compact` queued the built-in command. Do not issue a second `/compact`. |
| `klyth: queued compaction is stale: <changed>; history kept; run /compact after this change settles` | A real change to the history, configuration or permission state of the recipient made the queued request stale. |
| `klyth: queued auto-compaction is stale or disabled; history kept`, `klyth: queued auto-compaction is disabled; history kept` and `klyth: queued auto-compaction is stale; history kept` | The queued automatic compaction no longer applies. Auto-compaction is off, or the state changed. |
| `Complete draft saved at <path>; replacement returned for installation. Draft is context data, not an approval.` | Klyth saved the summary as a private draft (see above). |

## Remove Klyth

Stop routed work and auth commands before you remove credentials or the plugin. To release the host compaction override
while Klyth is still loaded, set `compaction.hostWindow` to `false` and run `/klyth reload`. **Restart Claude Code after
you disable or uninstall Klyth.** A live unload cannot restore the process-wide environment value. A fresh process
without Klyth inherits its ordinary environment.

Remove credentials you no longer need with `bun run auth logout <p>` from the Klyth checkout. A local logout does not
revoke the ChatGPT app connection on the provider side. To revoke it too, disconnect Klyth in your ChatGPT settings.
Keyless providers have no stored credential to remove.

Uninstall with `claude plugin uninstall klyth@klyth` and `claude plugin marketplace remove klyth`. Remove any
status-line setting you added, then restart. Klyth keeps its provider approvals and saved routes in its own host plugin
store. Removing a config file or a keyring item does not clear that store.

Treat retained data separately from installation files:

- Review `<configDir>/klyth/delivery-recovery/` and `<configDir>/klyth/compactions/` before you choose what to keep.
  These hold private message history and summary drafts, including pending evidence and receipts. Klyth has no
  automatic eviction, expiry or removal policy. Uninstalling it does not remove these records.
- `<configDir>/klyth/responses/` holds one file for each engine session. The file holds the provider ids, the input of
  each klyth agent call, and the thinking text or encrypted reasoning of routed tool turns. See
  [Response records](#response-records). A later klythd removes a file only when it finds that the transcript of its
  session is gone. Uninstalling does not remove the file.
- To remove the installation and the transient files, move the checkout, `klyth.json`, `klyth-host-id` and
  `~/.cache/klyth/` to the Trash. `klyth-host-id` belongs to registered-app sign-in. It is not a keyring item. The
  config files default to `~/.claude/` or follow `CLAUDE_CONFIG_DIR` when set.
- Move private archives or drafts to the Trash only as a separate, deliberate retention decision. Do not call them
  disposable caches. Backups outside these directories need their own retention decisions.
- A previous Styx installation has separate config, keyring and history locations. Credential migration does not remove
  those files, and it does not retire the source credential on its own. Follow
  [Switch from Styx to Klyth](PROVIDERS.md#switch-from-styx-to-klyth). Do not remove an unverified source.
