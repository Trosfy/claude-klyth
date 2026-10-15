# Security policy

## Reporting a vulnerability

Report it privately through GitHub. Open the repository's **Security** tab and choose **Report a vulnerability**. Do not
open a public issue. Include the Klyth commit, the output of `claude --version` and `bun --version`, and the steps that
reproduce the problem.

Fixes land on `main`. There are no maintained release branches.

## Scope

In scope:

- The key command (`auth.command`): how Klyth runs it, caches its output, and keeps the key out of argv, logs and the
  agent's environment.
- The approval prompt: routing without approval of the provider kind, URL origin or exact helper argv (or keyless auth).
- The helper's socket and token: any way for another process to reach the helper or replay a call.
- Inference requests: TLS and `allowHttp` handling, redirect refusal, and what Klyth sends a provider beyond the
  conversation.
- Credential migration: namespace isolation, no-clobber destination creation, exact verification, source retirement and
  registered-app host identity. Migration must not grant approval or copy session state.
- Private compaction drafts and delivery-recovery records: storage access, consent and provenance checks.

Out of scope:

- What a provider does with the data that you choose to send it.
- Claude Code's own Bash tool reading a keyring item of the same user. This is a documented limit. See the README's
  [Security](README.md#security) section.
