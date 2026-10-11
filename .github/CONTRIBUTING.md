# Contributing

FireCode is a [Pi](https://github.com/earendil-works/pi) extension. Please open an issue before starting a large change.

## Setup

Tests and the type check run against the Pi sources, not an installed package. You need [Bun](https://bun.sh) and a checkout of pi-mono at the tag CI uses (`PI_VERSION` in [ci.yml](workflows/ci.yml)) with its dependencies installed. The steps are the "Fetch pi-mono" step of that workflow:

```bash
git clone --depth 1 --branch <PI_VERSION> https://github.com/earendil-works/pi ../pi
npm ci --ignore-scripts --prefix ../pi
npm run hydrate:model-data --prefix ../pi      # generates the git-ignored model data pi-ai imports
export PI_PACKAGES_DIR="$PWD/../pi/packages"   # not needed if a dev build of `pi` from that checkout is on PATH
```

One test starts the real `pi` binary, so `pi` must be on `PATH` and `bun run build` must have produced `dist/` first (CI installs the same version globally).

## Checks

```bash
bun run build
bun run typecheck
bun test
```

The website in `site/` has its own dependencies; check it with `cd site && bun install && bun run check && bun run build`. Vercel builds it on push to `main` only when `site/`, `design/`, `README.md`, `README.zh-CN.md`, `config.example.jsonc` or `jsonc.ts` change. The site reads the tagline and the two tables from the README, so keep their format; see `site/AGENTS.md`.

## Pull requests

- Branch from `main` and keep one concern per PR.
- A behavior change comes with a test at the seam that fails without the change. Do not add tests for internals.
- Docs for contributors and agents (`AGENTS.md`, `WORDS.md`) are written in Chinese. If you write English, put the constraint or contract change in the PR description and the maintainer will update `AGENTS.md`. Code is the source of truth; docs only record what the code cannot show.
- CI (build, type check and `bun test`) must be green before review.
