# Set up Klyth (guide for an AI assistant)

You are an AI coding assistant. The user asked you to install and set up Klyth. Follow the steps in order.

Klyth is a mod for Claude Code. It routes selected model calls to another provider. Each provider uses its own
credentials and billing.

Ask the user before each step that needs a decision. Wait for the answer. You may have no checkout yet, so the links in
this guide are GitHub URLs. After step 2, read the same files in the checkout.

## Rules

- Never handle a key. Do not ask the user to paste a key into the chat. Do not put a key in a file, a command line or an
  environment variable. The user types the key into a hidden prompt.
- Apply the same rule to a ChatGPT sign-in. The user signs in alone. Do not automate the browser step. Do not read
  tokens. Keep the sign-in URLs out of the chat. Do not ask for a callback URL or for any text from the sign-in page.
- Send nothing to a provider without a yes from the user. Even a short prompt such as "say hi" sends the conversation to
  the provider. `bun scripts/klythd-smoke.ts` runs the configured key command and sends a prompt. A direct `curl` can
  also send credentials or conversation data. Ask before each live test.
- You cannot approve a provider. The user chooses **Allow** in the prompt that Klyth shows.
- Read `klyth.json` before you write to it. If the file exists, add to it. Never replace it.
- Edit only `klyth.json`, and keep the existing entries. An auth helper may update its own provider entry, but only when
  the user explicitly chooses `--write`. Read the config again after that, before your next edit.
- Leave Claude Code's settings and permissions alone. Suggest rules. Never add them.
- If the user is moving from Styx, stop this fresh-install flow. Follow
  [Switch from Styx to Klyth](https://github.com/Trosfy/claude-klyth/blob/main/docs/PROVIDERS.md#switch-from-styx-to-klyth).
  Do not copy credentials, approvals or session state yourself. Do not load both plugins. A request for setup does not
  allow you to migrate or retire credentials.

## 1. Check the machine

Run these commands. Tell the user which command fails.

- `claude --version`: Klyth needs 2.1.292 or later.
- `bun --version`: Klyth needs Bun for its helper process. The tested version is 1.3.11.
- `uname -s`: on Darwin, Klyth uses the Keychain at `/usr/bin/security`. On Linux, also run `command -v secret-tool`.
- `ls /usr/bin/curl`: the mod reaches its helper process through this curl.

If Bun is missing, tell the user to install it from bun.sh. Do not pipe a download into a shell without asking.

## 2. Get the code

Find a Klyth checkout. It is a folder that holds `.claude-plugin/plugin.json` and `klythd/main.ts`. Its name can be
anything. Check the current folder first. Then ask the user whether a checkout exists elsewhere. If you find one, note
its absolute path. This guide calls it the Klyth folder.

If you find none:

1. Ask the user where to keep a checkout. Claude Code loads Klyth from this folder in every session, so the folder must
   stay in place.
2. If git is missing, tell the user to install it.
3. Clone the repository into that folder:

   ```sh
   git clone https://github.com/Trosfy/claude-klyth.git /absolute/path/to/klyth
   ```

Klyth needs no `bun install`.

## 3. Install the mod

Run `claude plugin list`. If it shows `klyth`, skip this step.

The install changes Claude Code's settings, so the user runs these two commands. Replace the path with the absolute path
from step 2.

```sh
claude plugin marketplace add /absolute/path/to/klyth
claude plugin install klyth@klyth
```

Ask the user to tell you when both commands end. Claude Code loads Klyth in new sessions, not in the current session.
Tell the user to run `/reload-plugins` or to start a new Claude Code session. On the first load, Klyth's hook installs the
`klyth` command. You do not install this command. Klyth shows one notice after install. When `~/.local/bin` is in `PATH`,
it says `Klyth installed the klyth command in ~/.local/bin. Type klyth --help in a terminal.` When it is not in `PATH`, it
says `Klyth installed the klyth command in ~/.local/bin. Add ~/.local/bin to your PATH to use it.` After that load, ask
the user to run `command -v klyth` in a terminal.

If the command is missing, check these causes:

- `~/.local/bin` is not in `PATH`. Add it to `PATH`, or run `~/.local/bin/klyth`.
- Another program owns `~/.local/bin/klyth`. Klyth leaves that file unchanged. Use the fallback command in step 5.
- The user removed `~/.local/bin/klyth`. Klyth does not install it again by itself. Move
  `~/.local/share/klyth/launcher` to the Trash, then start a new Claude Code session.

## 4. Set up with `/klyth setup`

Use this path first. Tell the user to type `/klyth setup` in an interactive Claude Code terminal with Klyth loaded. The
command opens a setup pane. The user works in the pane. Do not try to operate it.

Before the user starts, tell the user about plain HTTP. For a plain `http://` address, the pane asks for consent first.
That connection is not encrypted. Anyone on the network path can read prompts, answers and any key, even on a LAN. For
remote use, recommend HTTPS or an encrypted tunnel to loopback.

ChatGPT uses OpenAI's "Sign in with ChatGPT" for third-party apps. It is a preview, and eligibility depends on the
account and the workspace. Before the user starts, read
[OpenAI with your ChatGPT plan](https://github.com/Trosfy/claude-klyth/blob/main/docs/PROVIDERS.md#openai-with-your-chatgpt-plan).
A workspace admin can block third-party apps, and then the sign-in page fails. Do not look for a way around that policy.
Tell the user to ask the admin to allow the app, or to use an API key.

Wait for the user to say that setup ends. Then do steps 6 and 7.

If the pane does not open and Klyth prints "Klyth setup needs an attached native pane", use step 5.

## 5. Set up by hand (fallback)

Use this path only when `/klyth setup` is not available or when the user asks for it. The user runs `klyth auth`
commands in a terminal. If `klyth` is missing, run `bun /absolute/path/to/klyth/scripts/cli.ts auth …` instead.

### Ask what to route to

Ask the user, in one message:

- Which provider: OpenAI, OpenRouter, the Anthropic API, Amazon Bedrock or an OpenAI-compatible server. For OpenAI: an
  API key, or the user's ChatGPT Plus or Pro plan.
- The base URL, and one or more model ids.
- The context window and maximum output tokens of each model. Copy them from the provider's model list. Do not guess
  them.
- A short alias for each model. The user types `/model <alias>` to select it.

Pick the kind with the [README's table](https://github.com/Trosfy/claude-klyth#which-provider-kind-should-i-pick). Use the
recipe in [PROVIDERS.md](https://github.com/Trosfy/claude-klyth/blob/main/docs/PROVIDERS.md). For Responses with an API
key, use
[OpenAI Responses API (API key)](https://github.com/Trosfy/claude-klyth/blob/main/docs/PROVIDERS.md#openai-responses-api-api-key).

For a ChatGPT plan, this guide covers only the registered-app sign-in. It uses
`klyth auth login chatgpt --provider <provider id>` and the base URL `https://api.openai.com/v1`. First read its eligibility
and workspace limits in
[the recipe](https://github.com/Trosfy/claude-klyth/blob/main/docs/PROVIDERS.md#openai-with-your-chatgpt-plan). Tell the
user that this path and the direct API-key Responses path are not yet live-checked.

A plain `http://` address needs `"allowHttp": true`. Ask before you enable it, and explain the risk from step 4.

### Write the config

The file is `klyth.json` in `$CLAUDE_CONFIG_DIR`, or in `~/.claude` when that variable is not set. Start from
`example.klyth.json` in the Klyth folder and from the recipe. The example defines the provider `openai` and the alias
`gpt`. Copy the provider, its model limits and its alias from the recipe.
[CONFIG.md](https://github.com/Trosfy/claude-klyth/blob/main/docs/CONFIG.md#providers) describes every key.

- In `auth.command`, use the provider id as the Keychain account.
- For a ChatGPT plan, the recipe's `token` command is a stand-in. The user's explicit `--write` choice replaces it with
  the installed command paths (see "Store the key").
- For a keyless endpoint, use `"auth": "none"`. Bedrock does not support keyless auth.

Leave out the `classifier` key unless the user runs auto mode on an alias and asks for it. Before you add it, explain
[Classifier](https://github.com/Trosfy/claude-klyth/blob/main/docs/CONFIG.md#classifier) to the user. It lets a model
stand in for a verdict. Never set `classifier.tools` to `"all"` unless the user asks for it by name.

Run the check in step 6. Then store the key.

### Store the key

If the provider uses `"auth": "none"`, skip this section.

Ask the user to run this command in their own terminal:

```sh
klyth auth login api-key <provider id>
```

The command asks for the key without echo and stores it in the Keychain (`secret-tool` on Linux). The example's key
command works on macOS only. On Linux, the user can add `--write` to write the `secret-tool` command into
`providers.<provider id>.auth`. [Keys](https://github.com/Trosfy/claude-klyth/blob/main/docs/PROVIDERS.md#keys)
describes other key stores.

For a ChatGPT plan, the provider must already be in `klyth.json`. Tell the user that `--write` rewrites the `auth` entry
of that provider. Ask the user to choose `--write` explicitly. Then ask the user to run this command in their own
terminal:

```sh
klyth auth login chatgpt --provider <provider id> --write
```

The command prints a URL, opens it and waits up to 5 minutes. The user finishes the browser step alone. For a browser on
another device, the recipe describes `--no-browser` and `--port <n>`.

A ChatGPT sign-in needs an available OS keyring. The command lists the model ids that the account can use. With the
user, put those ids and their verified limits in `klyth.json`. Read the config again. Run the check in step 6 again.

When the command ends, ask the user for the result. To check that the key exists, the user can run
`klyth auth status <provider id>`. It does not print the key. A keyring read error does not mean that the item is
absent.

## 6. Check the config

Run this check after step 4, after you write the config in step 5 and after each helper edit to `klyth.json`. Run it
in the Klyth folder. It prints every error, or `klyth.json: ok`. It makes no provider request.

```sh
bun -e 'import { parseConfig } from "./hooks/config.ts"; const p = `${process.env.CLAUDE_CONFIG_DIR || process.env.HOME + "/.claude"}/klyth.json`; const r = parseConfig(await Bun.file(p).text()); console.log(r.errors.length ? r.errors.join("\n") : "klyth.json: ok")'
```

Fix what it prints and run it again. It does not check an organization's managed policy. Klyth checks that policy when
it loads.

## 7. First use and approval

Tell the user to type `/model <alias>` (`/model gpt` for the example), or `/model <provider>/<model id>` when setup set
no alias. Klyth asks the user to approve the provider. The prompt shows the URL origin and the exact helper command, or
that Klyth sends no key. An approval binds to the kind, the origin and the helper command (or keyless mode). It does not
bind to the URL path, the model or the params. The user reads the prompt and chooses **Allow**.

Then `/klyth` shows the provider as approved, and the status line shows `<alias> · <provider>` (`gpt · openai` for the
example). `/model opus` goes back to Claude. After an edit to `klyth.json`, `/klyth reload` makes a loaded Klyth read
the file again.

## 8. Report

Tell the user:

- What you wrote and where.
- How to switch to a routed model and how to return to Claude.
- That a routed turn sends its prompts, files and tool output to the provider.
- That `git pull` in the Klyth folder, then `/reload-plugins`, updates Klyth.

For any `klyth:` error line, point to
[TROUBLESHOOTING.md](https://github.com/Trosfy/claude-klyth/blob/main/docs/TROUBLESHOOTING.md).

Setup is complete when all of these are true:

1. `klyth.json` passes the check in step 6.
2. Credentials are available, or the provider uses `"auth": "none"`.
3. `claude plugin list` shows `klyth`.
4. The user knows how to approve and select the route.

A live test is optional and needs separate permission. Send no request to a provider that the user has not approved.
