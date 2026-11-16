# Privacy and synthetic data

Tsukaima is a reusable project. Repository content must not identify a particular deployment,
operator, chat account, group, conversation, or sticker library. Real deployment values belong in
the operator's environment and private operations records, never in committed source or docs.

## Do not commit

- SSH targets, server IP addresses, tailnet/LAN hostnames, internal DNS names, and container or
  volume names.
- Personal home-directory paths, usernames, e-mail addresses, phone numbers, or account IDs.
- QQ numbers, group numbers, nicknames, message text, logs, transcripts, profile data, friend or
  group requests, and exported media.
- Telegram sticker-set links, titles, pack IDs, or creators copied from a private library.
- Tokens, passwords, cookies, authorization headers, API keys, private keys, or populated `.env`
  files.
- Screenshots or logs containing any of the above.

Use placeholders in docs: `<ssh-target>`, `<public-origin>`, `<repo-url>`, `<deployment-root>`,
`<container>`, `<account-id>`, and `<chat-id>`. Use `example.com`, `example.test`, or `.invalid`
domains. Use RFC 5737 addresses such as `192.0.2.10` when an address is required; reserve private
ranges such as `10.0.0.0/8` for tests that specifically exercise private-address rejection.

## Test and fixture rules

1. Every test identity is synthetic. Prefer names such as `Test User`, `Example User`, and
   `Test Bot`, with ids such as `10001`, `20001`, and `30001`.
2. Chat text in tests must be invented for the test. Never copy a production message, even a short
   greeting or a message used only as a parser example.
3. Keep localized text only when the test needs it to exercise language handling. Use neutral
   synthetic phrases, not a real user's speech.
4. Do not copy a production database into `packages/migration/fixtures` or any test directory.
   Migration fixtures contain schema shapes and synthetic rows only.
5. Do not use a real hostname, deployment path, container name, volume name, or package-manager
   cache path in a test. Use `ws://napcat.test`, `https://api.test`, `/synthetic/workspace`, and
   similar reserved names.
6. Temporary databases and media live under test temporary directories and are removed in
   `finally` blocks.
7. Tests must not require a live QQ/NapCat account, model provider, Docker daemon, or network
   endpoint.

## Deployment data

Deployment instructions use placeholders. The bootstrap and deploy scripts accept the host,
repository URL, branch, deployment root, public origin, and Docker network from the environment.
They contain no default production target.

Every deployment increases `VERSION` with strict SemVer. Version records under the deployment root
are operator data and are never copied into the repository.

## Before committing

Run:

```sh
bun run check:secrets
rg -n '(ssh |scp |root@|/home/[[:alnum:]_.-]+/|/Users/|10\.[0-9]+\.[0-9]+\.[0-9]+|192\.168\.|\.lan\b)' \
  --glob '!node_modules/**' --glob '!bun.lock' --glob '!data/**'
bun run check
```

Review every hit manually. Private-address tests and reserved example domains are allowed only
when the test is about private-address behavior or documentation uses explicit placeholders.

`bun run check:secrets` rejects tracked `.env` files, credential assignments, known secret
environment values, and SSH targets of the form `<user>@<private-or-public-IP>`. It cannot detect
every personal identifier, so review remains required.

## Git history

Removing a value from the current tree does not erase it from existing Git history. If a repository
that has already been shared contains a credential or personal chat data, rotate the credential and
coordinate a history rewrite with the repository owner before publishing. Never assume deleting the
working-tree file alone is sufficient.
