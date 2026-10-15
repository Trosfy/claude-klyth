<h1 align="center">Klyth</h1>

<p align="center"><b>Use other AI models inside Claude Code, and keep your Claude subscription</b><br>
Claude Code 2.1.292 or later · Bun · macOS or Linux · free and open source</p>

## Set it up with your AI assistant

Paste this line into Claude Code:

```text
Set up Klyth for me: follow https://github.com/Trosfy/claude-klyth/blob/main/docs/AI_SETUP.md
```

The assistant checks your machine, gets Klyth and helps you connect one provider. You type each key into a hidden
prompt, so the assistant never sees it. Only you can approve a provider.

## What is Klyth?

Klyth is a Claude Code mod. It sends the main conversation or a subagent to another model provider. Supported
providers are OpenAI, OpenRouter, the Anthropic API, Amazon Bedrock and OpenAI-compatible servers such as Ollama or
vLLM. Your Claude login stays with Claude Code. Each provider uses its own key and billing. Claude Code still runs
your tools and its permission checks.

## What you need

| | |
| --- | --- |
| **Claude Code** | 2.1.292 or later. `/klyth` tells you when its tool schemas do not match your build. |
| **Bun** | Klyth runs its helper process on Bun. We test with Bun 1.3.11. |
| **A provider** | An endpoint that speaks one of the [four kinds](#which-provider-kind-should-i-pick), with a model id and a key. A ChatGPT plan works through [Sign in with ChatGPT](docs/PROVIDERS.md#openai-with-your-chatgpt-plan). A local server without a key also works. |
| **A keyring** | The macOS Keychain, or `secret-tool` on Linux. Any command that prints the key also works, for example `pass`. |
| **System** | macOS or Linux, with `/usr/bin/curl`. |

## Quickstart

Do it yourself in five steps:

1. Clone Klyth into a folder that you keep. Claude Code loads Klyth from this folder.

   ```sh
   git clone https://github.com/Trosfy/claude-klyth.git /path/to/klyth
   claude plugin marketplace add /path/to/klyth
   claude plugin install klyth@klyth
   ```

2. Start a new Claude Code session, or run `/reload-plugins`. On this first load, Klyth installs the `klyth` command in
   `~/.local/bin`.
3. Run `/klyth setup`. Choose ChatGPT, Amazon Bedrock, an OpenAI-compatible endpoint or another API provider.
4. Connect the provider and choose a model. ChatGPT opens a sign-in page in your browser. For an API key, setup shows a
   command with a hidden prompt. Never paste a key into the chat.
5. Choose **Save and use model**. Approve the provider when Claude Code asks.

To return to Claude, type `/model opus` or the name of another native model. To update Klyth, run `git pull` in its
folder and then `/reload-plugins`. If you use Styx now, follow
[Switch from Styx to Klyth](docs/PROVIDERS.md#switch-from-styx-to-klyth). Do not load both plugins.

Provider recipes for a manual setup are in [docs/PROVIDERS.md](docs/PROVIDERS.md). Each config key is in
[docs/CONFIG.md](docs/CONFIG.md).

## Which provider kind should I pick?

The `kind` is the API that the endpoint speaks. Use the kind that the provider documents.

| Kind | Use it for | Status |
| --- | --- | --- |
| `openai` | OpenAI Chat Completions, OpenRouter, Ollama, vLLM, other OpenAI-compatible servers | Tested on a gateway and on Bedrock's OpenAI endpoint. Not yet tested against OpenAI. |
| `openai-responses` | The OpenAI Responses API, with an API key or a ChatGPT plan | Tested on the ChatGPT backend. Sign in with ChatGPT and the API-key path are not yet tested live. |
| `anthropic` | The Anthropic Messages API, or a gateway's `/v1/messages` | Tested on a gateway. Not yet tested against api.anthropic.com. |
| `bedrock` | Amazon Bedrock: Claude, GPT, Kimi and Grok | Tested with all four. Tool loops tested with Claude. |

## Using it

- **Move the main conversation:** type `/model <alias>`. Tab completes your aliases. The conversation moves with you.
  `/model opus` returns to Claude. A new session or `/clear` starts on Claude.
- **Run a subagent on another model:** ask for it by alias, for example "run an Explore agent on gpt". The subagent
  runs in the background and sends its report as a message. While main runs on an alias, a plain `Agent` call with no
  `model` runs on that alias too, with some exceptions.
  [Which subagents run on an alias](docs/TROUBLESHOOTING.md#which-subagents-run-on-an-alias) gives the rules.
- **See the state:** `/klyth` shows each provider, alias, routed subagent and recent step. `/klyth reload` reads
  `klyth.json` again.
- **See usage and cost:** `/klyth usage` opens the usage pane. Add model prices under
  [`pricing`](docs/CONFIG.md#pricing-and-usage) in `klyth.json` to see `Estimated cost:`.
- **Compact:** `/klyth compact` queues the built-in `/compact` when the conversation is idle. The routed model writes
  the summary. See
  [Compaction](docs/CONFIG.md#compaction).
- **Effort and thinking:** a routed request uses your session's effort level ([Effort](docs/CONFIG.md#effort)). Claude
  models on the `anthropic` and `bedrock` kinds also keep their thinking across tool calls
  ([Thinking](docs/CONFIG.md#thinking)).

## Status line

Klyth shows the route under the prompt, for example `gpt · openai`. Claude Code marks this line with a ⚠ icon. To show
the route without the icon, use Klyth's status line script:

1. Add `"statusLine": "command"` to `klyth.json`. Run `/klyth reload`.
2. Add this to `~/.claude/settings.json`. Replace `<klyth checkout>` with the path of your Klyth folder.

   ```json
   {
     "statusLine": { "type": "command", "command": "bun \"<klyth checkout>/scripts/statusline.ts\"", "refreshInterval": 5 }
   }
   ```

The line then shows `◆ gpt · openai` while a route is on, and `◇ Opus` when Claude answers. This setting replaces your
current status line. A nonempty `NO_COLOR` environment variable removes the colors. To undo the change, remove both
settings. [Top-level keys](docs/CONFIG.md#top-level-keys) has the details.

## Something went wrong?

- **Klyth shows an error line.** Each Klyth error is one line that ends with its fix. `/klyth` also names the next
  step. [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) lists every message.
- **`/klyth setup` says that it needs an attached native pane.** Run it in an interactive Claude Code terminal.
- **A change to the Klyth code has no effect.** Run `/reload-plugins`. `/klyth reload` reads only `klyth.json`.
- **You need more detail.** Start `claude --debug`. Each routed step writes one `klyth step` line to the debug log.
  [Troubleshooting](docs/TROUBLESHOOTING.md) explains its fields.

Open an [issue](https://github.com/Trosfy/claude-klyth/issues) if you are still stuck. Do not attach a full debug log.
It can contain prompts and other private data.

## How does it work?

<p align="center"><img src="docs/media/how-it-works.svg" width="860" alt="A routed Claude Code inference step goes through the Klyth mod to klythd, which calls the selected provider using separate credentials. Native inference stays with Claude Code and its own authentication."></p>

- **The mod** answers Claude Code's `turn.step` hook, which runs before each model request. For an alias, the mod
  builds the prompt and sends it to klythd. A native step continues to Claude as usual.
- **klythd** is one small helper process per session. It runs your key command, sends the request to the provider
  and streams the answer back. It stops after 10 idle minutes (65 with a 1-hour prompt cache), or when Claude Code
  exits.
- **A failure stays on its route.** Klyth shows an error. It never sends the turn to Claude instead.

## Security

- **Keys:** Klyth gets each key from a helper command, for example the macOS Keychain. The built-in helper keeps keys
  out of `klyth.json`, command lines, environment variables and logs. Do not put a key in the arguments of a custom
  helper.
- **Approval:** Klyth sends nothing to a provider until you approve it. The approval binds to the provider kind, origin
  and full command argv. It does not bind to the launcher's contents, the Klyth release, Bun or a script hash. A Klyth
  update changes the code that runs under an approved launcher command. To require approval for each release, set
  `auth.command` to that release's own `scripts/cli.ts` path. The line 2 marker shows ownership. It is not an authenticity
  check.
- **Your data:** a routed turn sends its prompts, the files the model reads and the tool output to the provider. Route
  only to providers that may get that data.
- **HTTPS:** use HTTPS or an encrypted tunnel. Plain HTTP needs `"allowHttp": true` and sends everything in clear text.
- **Permissions:** routed subagents get the same permission checks as other actions. An optional
  [classifier](docs/CONFIG.md#classifier) can give auto mode's verdict on a routed turn.
- **Limit:** Claude Code's Bash tool can read your Keychain item. Deny `security find-generic-password` and
  `Bash(klyth auth *)` in `/permissions`.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Credits and license

Klyth is open source under the [MIT License](LICENSE). Claude Code belongs to Anthropic. Klyth is an independent mod.
Klyth reads nothing from the Claude Code binary. Each prompt that Klyth sends comes from Klyth, from your agent files,
or from the session through the hook API. To remove Klyth, follow
[Remove Klyth](docs/TROUBLESHOOTING.md#remove-klyth). To work on Klyth, see [CONTRIBUTING.md](CONTRIBUTING.md).
