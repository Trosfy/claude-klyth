# Provider cookbook

Each recipe is one entry under `providers` in `~/.claude/klyth.json`, plus an optional alias.
[CONFIG.md](CONFIG.md#providers) explains every key. Model ids and limits change, so copy them from the provider's
current model list.

| Recipe | Kind | Live-test status |
| --- | --- | --- |
| [OpenAI](#openai) | `openai` | The shipped example. The kind ran live on a self-hosted gateway and on Bedrock's OpenAI endpoint. Not run against OpenAI. |
| [OpenAI with your ChatGPT plan](#openai-with-your-chatgpt-plan) | `openai-responses` | Designed from OpenAI's docs. Not live-tested. |
| [OpenAI Responses API (API key)](#openai-responses-api-api-key) | `openai-responses` | Designed from OpenAI's docs. Not live-tested. |
| [OpenRouter](#openrouter) | `openai` | Same code path as OpenAI. Not run against OpenRouter. |
| [Anthropic API](#anthropic-api) | `anthropic` | Tested offline, and live on a gateway's Messages endpoint. Not run against api.anthropic.com. |
| [Amazon Bedrock](#amazon-bedrock) | `openai` or `bedrock` | Live-tested with Claude, GPT, Kimi and Grok. |
| [Any OpenAI-compatible endpoint](#any-openai-compatible-endpoint) | `openai` | Used live on a self-hosted gateway. Not run against Ollama or vLLM. |

## Keys

An authenticated provider needs `auth.command`, a command that prints the key. A keyless server uses `"auth": "none"`
instead. `/klyth setup` configures a provider interactively. The `klyth` command-line interface stores credentials in
the macOS Keychain or in Linux `secret-tool`. It has explicit login methods:

```sh
klyth auth login chatgpt --provider chatgpt --write
klyth auth login api-key openai --write
klyth auth status openai --json
klyth doctor
```

From a source checkout, replace `klyth` with `bun /absolute/path/to/klyth/scripts/cli.ts`.

- `--write` updates `auth.command` of a provider that is already in `klyth.json`. For a new provider, run `/klyth setup`
  first. For ChatGPT, the provider must also match its recipe, with the same `kind` and `baseUrl`. Otherwise login stops
  before it signs in. Without `--write`, login stores the credential and leaves the configuration alone.
- `--provider <id>` replaces the default ChatGPT provider id `chatgpt`.
- Login does not replace a credential made with a different sign-in method. Run `klyth auth logout <provider-id>` first,
  or choose another provider id.
- Klyth hides API-key input in a terminal. Noninteractive use requires `--stdin`. Never give a key as an argument.
- `status` and `doctor` make no network request. On Linux, `status` reports presence as unknown. It does not read or
  unlock a secret only to check that it exists.
- `klyth auth token` prints an access token for the credential helper. Never run it where a chat transcript records it.

In a Klyth checkout, `bun run auth` is the legacy form and still works. A provider id follows
[the rules in CONFIG.md](CONFIG.md#providers).

```sh
klyth auth login api-key openai            # asks for the key (hidden), stores it, prints the auth line
klyth auth login api-key openai --write    # also writes that line into providers.openai
klyth auth status openai                  # says whether the item exists, never prints the key
klyth auth logout openai                  # removes the item and leaves klyth.json unchanged
```

- On macOS, the key command is `/usr/bin/security find-generic-password -s klyth -a <provider> -w`. The key reaches
  `security` on stdin, never on a command line. The helper refuses a key that contains `"`, `\` or a non-visible
  character, and it stores nothing.
- On Linux, the key command is `secret-tool lookup service klyth provider <provider>`, with the absolute path of
  `secret-tool`. Without `secret-tool`, `login` prints lines for `pass` and `op read` and exits 1. A locked, denied or
  unavailable keyring is an error, not proof that the item is absent.
- Any other store works if its command has an absolute path and prints the key.
- A ChatGPT sign-in uses the same keyring item and adds three commands: `klyth auth login chatgpt --provider <id>`,
  `klyth auth token <id>` and `klyth auth export <id>`. `token` is the key command.

```json
"auth": { "command": ["/usr/bin/pass", "show", "klyth/openai"] }
"auth": { "command": ["/usr/bin/jq", "-er", ".openai.key", "/path/to/provider-auth.json"], "ttlSeconds": 600 }
```

## Switch from Styx to Klyth

Klyth reads only `klyth.json` and its own credential namespace. It has no fallback to `styx.json`, old environment keys
or the Styx plugin store. An installed key does not approve a provider. Do not load both plugins in one Claude Code
process.

1. Stop every Claude Code process that uses either plugin, their helper processes and all other auth commands. Keep them
   stopped until migration ends. A lock does not protect a copy from an old runtime that still refreshes.
2. Prepare `klyth.json` in your Claude config directory. Review the old config. Do not only rename it. Use service
   `klyth` in keyring commands. Use absolute paths in the Klyth checkout that you keep for `scripts/cli.ts` and the
   status-line helper. Change each `STYX_*` environment key to its `KLYTH_*` counterpart. A provider that uses a
   sign-in must keep its `klyth auth token <provider>` helper. Do not read its serialized OAuth record directly as an API key.
3. Replace the `styx@claude-styx` plugin with `klyth@klyth`. The [Quickstart](../README.md#quickstart) has the install
   commands. Do not load both plugins. Installing the plugin does not transfer credentials and does not authorize
   routing.
4. From the Klyth checkout, run this command for each provider:

   ```sh
   klyth auth migrate <provider> --from styx --runtimes-stopped
   ```

   The command requires the `--runtimes-stopped` flag. The flag states that you stopped the old and new runtimes and all
   other auth commands. The command asks no questions, so add the flag only after you meet that condition. The command
   copies the complete serialized record (an API key or `v1|...`) from service `styx` to service `klyth`
   for the same provider. It checks the copy by exact readback in memory, prints no token and writes no plaintext file.
   A retry succeeds when the destination holds the identical record. The command never overwrites a different or
   unreadable destination and reports a conflict.
5. A registered-app `v1|...` sign-in also needs its host identity. Migration copies `styx-host-id` to `klyth-host-id`
   in the same Claude config directory. It refuses a missing, unreadable or unsafe source identity and a conflicting
   destination. Do not generate a new host id to avoid the refusal. API keys need no host-id
   transfer.
6. Check the result before you start anything. Migration is not atomic across the keyring and the host-id file. A
   failure can leave a copied destination or another partial state. Without `--retire-source`, migration never removes
   the source. If retirement ran and its check failed, the source may be gone. Keep both runtimes stopped, read the
   reported state and resolve it before you retry. Do not assume that a failed command wrote nothing.
7. Start a fresh Claude Code process with only Klyth loaded. It starts native, without Styx approvals or saved routes.
   Run `/model <alias>`. Review the provider origin and the exact helper command, and approve them before routed work.
   Old tool ids, subagents and transcripts may not resume under the new plugin identity.

The default keeps the source record. Do not let old and new copies of an OAuth record refresh at the same time.
Refresh-token rotation can invalidate one of them. To retire the source, add `--retire-source` while both runtimes and
all other auth commands stay stopped:

```sh
klyth auth migrate <provider> --from styx --runtimes-stopped --retire-source
```

Retirement runs only after the readback check and any required host-id transfer. Migration refuses to remove a source
that changed or became unreadable. Retirement does not remove old config, host-id files or private history. Returning to
an old copy after a refresh is not a reliable credential rollback.

Linux migration is not supported, because `secret-tool` cannot create an item without replacing one. The command stops
before it reads keyring records. Ordinary Linux login, refresh and keyless routing still work. Do not use a store
command that can replace an item, or `export`, for this migration. `export` removes its source after it writes a pipe
and does not check the destination.

Credential migration copies no provider approval, saved route, session state, compaction draft or delivery-recovery
archive. Old recovery evidence stays as private history at its old path, with no automatic import, expiry or removal.
Review it and keep it separately. See [delivery recovery](CONFIG.md#delivery-recovery-aid) and
[removal](TROUBLESHOOTING.md#remove-klyth).

## OpenAI

This is the provider in `example.klyth.json`. OpenAI reasoning models reject `max_tokens`, so the model sets
`"maxTokensParam": "max_completion_tokens"`.

```json
"openai": { "kind": "openai", "baseUrl": "https://api.openai.com/v1",
            "auth": { "command": ["/usr/bin/security", "find-generic-password", "-s", "klyth", "-a", "openai", "-w"] },
            "models": { "gpt-5": { "contextWindow": 400000, "maxInputTokens": 272000, "maxOutputTokens": 128000,
                                   "maxTokensParam": "max_completion_tokens",
                                   "effort": { "low": { "reasoning_effort": "low" }, "medium": { "reasoning_effort": "medium" },
                                               "high": { "reasoning_effort": "high" } } } } }
```

```json
"aliases": { "gpt": { "target": "openai/gpt-5", "note": "OpenAI GPT-5 on your own API key" } }
```

## OpenAI with your ChatGPT plan

This recipe uses "Sign in with ChatGPT", OpenAI's third-party developer sign-in. Where OpenAI permits it,
`/model <alias>` and `mcp__klyth__agent` use your ChatGPT plan instead of API-key billing. The integration targets
OpenAI's preview. Each user registers the app at first sign-in.

**Who can use it.** The preview documentation describes access for open-source projects, local personal projects and
selected private apps, with an interest form for paid or remotely hosted apps. Eligibility can change, so check
OpenAI's current requirements. Workspace admins can disable apps, and Enterprise or Edu workspaces may disable new apps
by default. "Sign in with ChatGPT" has its own admin control. A workspace that blocks third-party app connections cannot
use this path. Ask the admin or use an allowed API-key route. Another sign-in method does not bypass this policy.

Add the provider and an alias to `klyth.json`. The `auth` line is a stand-in. With `--write`, login replaces it.
Otherwise login prints the line to paste. Use the model ids that login lists for your account.

```json
"chatgpt": { "kind": "openai-responses", "baseUrl": "https://api.openai.com/v1",
             "auth": { "command": ["/path/to/bun", "/path/to/klyth/scripts/cli.ts", "auth", "token", "chatgpt"], "ttlSeconds": 600 },
             "models": { "gpt-6.1-sol": { "contextWindow": 400000, "maxInputTokens": 272000, "maxOutputTokens": 128000,
                                          "params": { "include": ["reasoning.encrypted_content"], "reasoning": { "summary": "auto" } },
                                          "effort": { "low": { "reasoning": { "effort": "low" } }, "medium": { "reasoning": { "effort": "medium" } },
                                                      "high": { "reasoning": { "effort": "high" } } } } } }
```

```json
"aliases": { "sol": { "target": "chatgpt/gpt-6.1-sol", "note": "GPT-6.1 Sol on your ChatGPT plan" } }
```

Then sign in:

```sh
klyth auth login chatgpt --provider chatgpt --write
```

Login prints a URL, opens it in your browser and waits up to 5 minutes. Sign in and allow Klyth to use your plan. Login
stores the sign-in in the Keychain (`secret-tool` on Linux) and lists the models on your plan. Then type `/model sol` and
approve the provider.

The key command prints an access token and refreshes it without a browser. The refresh token stays in the keyring item,
never in config or argv. Expiry, revocation, account policy or token rotation can require a new interactive login.

**No browser on this machine, or something blocks the redirect.** A sign-in needs a browser somewhere. You have three
options:

- **Forward the port.** Login listens on `127.0.0.1:1455`. From the machine with the browser, run
  `ssh -L 1455:127.0.0.1:1455 <this host>` and open the printed URL there. If port 1455 is in use, pass `--port <n>` and
  forward that number.
- **Paste the URL.** Sign in on any device. The page it lands on may not load, but the address bar holds the URL. Paste
  that URL soon into the waiting terminal, because its code is short-lived. Pass `--no-browser` when the machine has no
  browser.
- **Move the sign-in.** First check that the remote launcher works:
  `ssh <host> '"$HOME/.local/bin/klyth" --version'`. Then sign in on a laptop and run
  `klyth auth export chatgpt | ssh <host> '"$HOME/.local/bin/klyth" auth import chatgpt'`. The provider must already be
  in that machine's `klyth.json`. Add `--write` to the import command to write its key command. `export` refuses a terminal
  and removes the local item after it writes the whole sign-in. A finished pipe does not prove that the other machine
  stored the sign-in. A failed import can require a new sign-in.

No option bypasses a workspace or single sign-on policy that refuses third-party apps. If your browser hides the URL,
or you cannot copy a URL of about 300 characters, use another device or the move.

**One sign-in per machine.** Refresh can rotate the refresh token, so two machines that refresh copies of one record can
invalidate each other ([Troubleshooting](TROUBLESHOOTING.md#chatgpt-sign-in-and-plan-usage)). Sign in separately on each
machine, or stop using the source before you move a sign-in.

**Headless Linux.** Login needs `secret-tool` with a running keyring daemon and an unlocked login collection.

**Limits.** The registered-app preview supports a per-app plan allowance in ChatGPT settings. Reaching it produces an
HTTP 429 usage-limit error. `klyth auth logout <provider id>` removes only the local sign-in. To end the provider-side
connection, also revoke the matching app in ChatGPT settings.

**What plan usage does not take.** OpenAI's preview limits say to leave these request fields out: `background`,
`conversation`, `max_output_tokens`, `max_tool_calls`, `metadata`, `moderation`, `multi_agent`, `prompt`,
`prompt_cache_retention`, `safety_identifier`, `temperature`, `top_logprobs`, `top_p`, `truncation` and `user`. Do not
set `maxTokensParam` on these models. Keep the other fields out of `params`. Plan usage also lacks image generation,
file search, Code Interpreter and computer use. It lacks hosted MCP, connectors, `tool_search`, audio and video input,
and the Files API. Image support on plan usage is not known. If OpenAI refuses a step that has an image, set
`"vision": false` on the model.

## OpenAI Responses API (API key)

This recipe uses OpenAI's public API URL with an API key and separate API billing. It needs no ChatGPT `token` helper
and no account headers.

```json
"openai-responses": { "kind": "openai-responses", "baseUrl": "https://api.openai.com/v1",
                      "auth": { "command": ["/usr/bin/security", "find-generic-password", "-s", "klyth", "-a", "openai-responses", "-w"] },
                      "models": { "gpt-5": { "contextWindow": 400000, "maxInputTokens": 272000, "maxOutputTokens": 128000,
                                             "maxTokensParam": "max_output_tokens" } } }
```

```json
"aliases": { "gpt-responses": "openai-responses/gpt-5" }
```

Store the key with `klyth auth login api-key openai-responses`. On Linux, add `--write` to replace the example's
Keychain command with `secret-tool`. Set `maxTokensParam` on the model, not on the provider. Do not copy it into the
ChatGPT plan recipes, whose supported params differ.

## OpenRouter

OpenRouter model ids look like `vendor/name`. An alias splits at the first `/` only ([Aliases](CONFIG.md#aliases)).

```json
"openrouter": { "kind": "openai", "baseUrl": "https://openrouter.ai/api/v1",
                "auth": { "command": ["/usr/bin/security", "find-generic-password", "-s", "klyth", "-a", "openrouter", "-w"] },
                "models": { "openai/gpt-4.1": { "contextWindow": 1047576, "maxOutputTokens": 32768, "maxTokensParam": "max_tokens" } } }
```

```json
"aliases": { "gpt41": "openrouter/openai/gpt-4.1" }
```

## Anthropic API

Native turns use your Claude login and need no recipe. Use this recipe to route to the Anthropic API with another API
key, such as a key from a different organization.

```json
"anthropic": { "kind": "anthropic", "baseUrl": "https://api.anthropic.com",
               "auth": { "command": ["/usr/bin/security", "find-generic-password", "-s", "klyth", "-a", "anthropic", "-w"] },
               "models": { "claude-sonnet-5-5": { "contextWindow": 1000000, "maxOutputTokens": 64000, "cache": "5m",
                                                  "effort": { "low":  { "thinking": { "type": "adaptive" }, "output_config": { "effort": "low" } },
                                                              "high": { "thinking": { "type": "adaptive" }, "output_config": { "effort": "high" } } } } } }
```

Klyth sends the key in the `x-api-key` header and adds `anthropic-version: 2023-06-01` to every request. For a gateway
that wants a Bearer token, set `"authHeader": "bearer"`. The `baseUrl` has no `/v1`, because Klyth adds `/v1/messages`.
For `thinking` and `cache`, see [Thinking](CONFIG.md#thinking) and [Prompt cache](CONFIG.md#prompt-cache).

## Amazon Bedrock

The table lists the models tested with a long-term API key. Each row streamed a counting answer in full. In the tested
region, these models were reachable only through `global.` inference profiles. Two-step tool loops also passed on Claude
Sonnet 5.5 and Haiku 4.5, with thinking and the prompt cache on. The second step read the cache of the first.

| Family | Model id (global inference profile) | `bedrock` kind | `openai` kind |
| --- | --- | --- | --- |
| Claude Sonnet 5.5, Sonnet 4.6, Opus 5.5, Haiku 4.5 | `global.anthropic.claude-sonnet-5-5`, `…-sonnet-4-6`, `…-opus-5-5`, `…-haiku-4-5-20251001-v1:0` | works | not offered by AWS |
| GPT-5.6 Luna | `global.openai.gpt-5.6-luna` | works (recommended: one provider for every family) | works |
| GPT-6 Luna, Sol | `global.openai.gpt-6-luna`, `global.openai.gpt-6-sol` | works | 403 on the account tested (a Marketplace entitlement for the `/openai/v1` path) |
| Kimi K3 | `global.moonshotai.kimi-k3` | works | works (AWS recommends this kind for multi-turn) |
| Grok 4.7 | `global.xai.grok-4.7` | works | works |

A short-term Bedrock key lasts at most 12 hours. Set `ttlSeconds` below the key's life, and use a key command that
mints a fresh key. A long-term key is an IAM service credential. The region is part of the `baseUrl`. There is no
`region` key.

**GPT on the `bedrock` kind.** These results come from GPT-5.6 Luna:

- Effort goes in `additionalModelRequestFields.reasoning.effort`. The levels are `none`, `low`, `medium`, `high`,
  `xhigh` and `max`. Bedrock refuses `minimal`. `reasoning_effort` is an unknown parameter on Converse. This path does
  not report reasoning tokens separately.
- Do not set `cache` on a GPT model, because Bedrock answers an explicit `cachePoint` with HTTP 403 ("did not allow
  prompt caching"). In the measurement, repeated prefixes read from the cache without markers, also through the `openai`
  kind. The measurement observed reuse. It does not guarantee retention or reuse across protocols.

```json
"global.openai.gpt-5.6-luna": { "contextWindow": 1050000, "maxInputTokens": 922000, "maxOutputTokens": 128000,
  "effort": { "low":   { "additionalModelRequestFields": { "reasoning": { "effort": "low" } } },
              "xhigh": { "additionalModelRequestFields": { "reasoning": { "effort": "xhigh" } } } } }
```

**Claude: the `bedrock` kind.** Use the model id or inference profile id from the Bedrock console.

```json
"bedrock": { "kind": "bedrock", "baseUrl": "https://bedrock-runtime.us-east-1.amazonaws.com",
             "auth": { "command": ["/usr/bin/security", "find-generic-password", "-s", "klyth", "-a", "bedrock", "-w"], "ttlSeconds": 3000 },
             "models": { "global.anthropic.claude-sonnet-5-5": { "contextWindow": 1000000, "maxOutputTokens": 32000, "cache": "5m",
                                                                  "effort": { "low":  { "additionalModelRequestFields": { "thinking": { "type": "adaptive" }, "output_config": { "effort": "low" } } },
                                                                              "high": { "additionalModelRequestFields": { "thinking": { "type": "adaptive" }, "output_config": { "effort": "high" } } } } } } }
```

Claude Haiku 4.5 thinks only with a budget:
`"additionalModelRequestFields": { "thinking": { "type": "enabled", "budget_tokens": 4096 } }`.

**Non-Claude models: the `openai` kind.** AWS recommends the OpenAI-compatible endpoint of bedrock-runtime. The other
endpoint is `https://bedrock-mantle.<region>.api.aws/v1`. Claude is not on Chat Completions.

```json
"bedrock-oss": { "kind": "openai", "baseUrl": "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1",
                 "auth": { "command": ["/usr/bin/security", "find-generic-password", "-s", "klyth", "-a", "bedrock-oss", "-w"], "ttlSeconds": 3000 },
                 "models": { "openai.gpt-oss-120b-1:0": { "contextWindow": 128000, "maxOutputTokens": 32768, "maxTokensParam": "max_tokens" } } }
```

The limits in these examples are placeholders. Copy each model's limits from its Bedrock model card. Extra Converse
fields go in `params`, for example `additionalModelRequestFields`. Klyth refuses `messages`, `system` and `toolConfig`
there ([Request bodies](CONFIG.md#request-bodies)).

## Any OpenAI-compatible endpoint

A local server (Ollama, vLLM) or a gateway in front of other models (a LiteLLM proxy, for example) works with the
`openai` kind. Point `baseUrl` at the server's `/v1`. A gateway that also serves the Messages API works with the
`anthropic` kind ([Anthropic API](#anthropic-api)). Ollama and vLLM use plain HTTP, so the provider needs `allowHttp`.
The address must be a DNS name or an IP address, such as `127.0.0.1` or a LAN or VPN name. It must not be `localhost`.

```json
"ollama": { "kind": "openai", "baseUrl": "http://127.0.0.1:11434/v1", "allowHttp": true, "auth": "none",
            "models": { "your-model:8b": { "contextWindow": 32768, "maxOutputTokens": 8192, "maxTokensParam": "max_tokens" } } }
```

- Set `contextWindow` to the size that the server loads: `num_ctx` in Ollama or `--max-model-len` in vLLM. The default
  in Ollama is small. `ollama list` prints the model ids of Ollama.
- A reasoning model on vLLM needs `--reasoning-parser`. Without it, its `<think>` text arrives as ordinary text. If you
  start vLLM with `--api-key`, it checks a key. Then use an `auth.command` (`klyth auth login api-key vllm`) instead of
  `"none"`.
- `"none"` sends no key. Plain HTTP exposes prompts and answers to anyone on the path, and a private LAN does not
  encrypt them. Use HTTPS for a remote endpoint, or an encrypted tunnel that ends at loopback. `allowHttp` is explicit
  permission to use the unencrypted hop ([`auth`](CONFIG.md#providers)).
- A gateway key that allows only some models answers every other model with one line that lists the allowed models.
