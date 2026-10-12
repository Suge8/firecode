# Contributing

FireCode is a [Pi](https://github.com/earendil-works/pi) extension. Please open an issue before starting a large change.

## Setup

Tests and the type check run against the Pi sources, not an installed package. You need [Bun](https://bun.sh), Node.js with npm, and git. One command fetches pi-mono at the pinned version (`PI_VERSION` in [scripts/pi-source.ts](../scripts/pi-source.ts), the only place the version is written; CI uses the same command) into a cache outside the repo and installs its dependencies:

```bash
bun run setup
```

The checkout goes to `~/.cache/firecode/pi-<version>` (set `FIRECODE_PI_DIR` to put it elsewhere). Running it again does nothing once the directory is complete. Tests and the type check look for the Pi sources in this order: `PI_PACKAGES_DIR` (the `packages/` directory of your own pi-mono checkout), the setup cache, then a dev build of `pi` on `PATH`. The `pi-smoke` test runs the CLI from those same sources, so no global `pi` is needed. To move to a newer pi, change `PI_VERSION` and run `bun run setup` again.

## Checks

```bash
bun run build
bun run typecheck
bun test
```

`evals/` is a maintainer-only tool for evaluating delegation. It needs the maintainer's own login credentials and spends real money, so contributors do not need to run it.

The website in `site/` has its own dependencies; check it with `cd site && bun install && bun run check && bun run build`. Vercel builds it on push to `main` only when `site/`, `design/`, `README.md`, `README.zh-CN.md`, `config.example.jsonc` or `jsonc.ts` change. The site reads the tagline and the two tables from the README, so keep their format; see `site/AGENTS.md`.

## Releasing

Releases are published to npm by [release.yml](workflows/release.yml) when a GitHub Release is published. It runs the same checks as CI against the tag, requires the tag to equal `v` + the `version` in `package.json`, and publishes with npm [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, no npm token; provenance is attached automatically).

1. Change `version` in `package.json` and move the `[Unreleased]` entries in `CHANGELOG.md` under the new version.
2. Merge that to `main`.
3. On GitHub, create a Release with a new tag `v<version>` on `main` and publish it. The workflow publishes the package.

If a publish fails, fix the cause and run the Release workflow again from the Actions tab with the same tag.

One-time npm setup (package settings on npmjs.com → Settings → Trusted publishing → GitHub Actions; the CLI equivalent needs npm ≥ 11.15 and 2FA: `npm trust github pi-firecode --repo Suge8/firecode --file release.yml --allow-publish`):

| Field | Value |
| --- | --- |
| Organization or user | `Suge8` |
| Repository | `firecode` |
| Workflow filename | `release.yml` |
| Environment name | empty |
| Allowed actions | tick `npm publish` |

npm does not check these when you save them, and the setup expires if no publish succeeds within 2 days. After the first successful publish you can set the package's Publishing access to "Require two-factor authentication and disallow tokens".

## Pull requests

- Branch from `main` and keep one concern per PR.
- A behavior change comes with a test at the seam that fails without the change. Do not add tests for internals.
- Docs for contributors and agents (`AGENTS.md`, `WORDS.md`) are written in Chinese. If you write English, put the constraint or contract change in the PR description and the maintainer will update `AGENTS.md`. Code is the source of truth; docs only record what the code cannot show.
- CI (build, type check and `bun test`) must be green before review.
