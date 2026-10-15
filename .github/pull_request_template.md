## What and why

## Checks

- [ ] The [gates in CONTRIBUTING.md](../CONTRIBUTING.md#the-gates) pass locally (CI covers the Bun-only gates).
- [ ] A behaviour fix ships with a test that fails before it and passes after it.
- [ ] Docs changed where behaviour did; examples, plugin names and local links match.
- [ ] Tests use synthetic credentials and offline fixtures, not real keyrings or provider requests.
- [ ] Shared logs/config excerpts contain no secrets or private paths.
