# Publishing a release

Releases are published by CI, never by hand. `.github/workflows/publish.yml` is the only writer of
release tags, GitHub releases, `CHANGELOG.md`, and the `VERSION` bump, so the tag, the notes, and
the deployable revision cannot drift apart.

Related documents:

- [Deployment](deployment.md)
- [Docker deployment version policy](deployment.md#2-version-policy)
- [Changelog](../../CHANGELOG.md)

## One-time setup

1. **Repository variable** under Settings → Secrets and variables → Actions → Variables:

   | Name | Value |
   | --- | --- |
   | `UPSTREAM_REPOSITORY` | `<owner>/<repo>` of the canonical repository |

   The workflow's `if` compares `github.repository` with this value. A fork leaves the variable unset
   and the job is skipped, which is what makes publishing upstream-only.

2. **Optional `PUBLISH_TOKEN`** secret: a fine-grained PAT with `contents: write` for the repository.
   Use it when `main` is protected against `GITHUB_TOKEN`; the workflow falls back to
   `GITHUB_TOKEN` otherwise.

3. **Optional environment protection**: the job runs in the `publish` environment, so required
   reviewers or a deployment branch rule can be added under Settings → Environments.

## Running a publish

1. Actions → **publish** → *Run workflow* on `main`.
2. Choose `patch`, `minor`, or `major`; optionally add a prerelease identifier such as `rc.1`.
3. The workflow:
   - runs `bun run check` and the WebUI build on the current `main`;
   - computes the next strict SemVer from `VERSION`;
   - updates `VERSION` and every workspace manifest together;
   - prepends the release section to `CHANGELOG.md` and writes the same text as release notes;
   - commits `chore(release): <version>`, creates an annotated `v<version>` tag, and pushes both;
   - creates the GitHub release for that tag.

Deployment stays a separate, explicit step: run the deploy script against the release commit. The
deployer still refuses an equal or lower `VERSION`.

## Changelog rules

`tools/ops/changelog.ts` groups the commits between the previous tag and the release tag:

| Prefix | Section |
| --- | --- |
| `feat` | Added |
| `fix` | Fixed |
| `docs`, `refactor`, `perf`, `test`, `ci`, `build`, `style`, `revert` | Changed |
| `chore` | omitted |

Subjects without a conventional prefix land under Changed. Write commit subjects for this
audience: they are published verbatim, minus the prefix, with the scope kept.

## Notes

- Versions only increase. A bad release is followed by a new patch release, not a rewritten tag.
- Deleting a tag or release is a manual operator action and is never part of the workflow.
- Forks can build and deploy their own branches, but they cannot publish releases.
