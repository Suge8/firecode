# Contributing

FireCode is a [Pi](https://github.com/earendil-works/pi) extension. Please open an issue before starting a large change.

## Setup

Tests and the type check run against the Pi sources, not an installed package. You need [Bun](https://bun.sh) and a checkout of pi-mono at the tag CI uses (see `PI_VERSION` in `.github/workflows/ci.yml`, currently `v1.1.0`) with its dependencies installed:

```bash
git clone --depth 1 --branch v1.1.0 https://github.com/earendil-works/pi ../pi
npm ci --ignore-scripts --prefix ../pi
npm run hydrate:model-data --prefix ../pi      # generates the git-ignored model data pi-ai imports
export PI_PACKAGES_DIR="$PWD/../pi/packages"   # not needed if a dev build of `pi` from that checkout is on PATH
```

The tests locate pi-mono through `PI_PACKAGES_DIR`, or through a dev-build `pi` on `PATH` (`tests/loader.ts`); the type check uses the same lookup. One test starts the real `pi` binary, so `pi` must be on `PATH` and `bun run build` must have produced `dist/` first.

## Checks

```bash
bun run build
bun run typecheck
bun test
```

`typecheck` runs pi-mono's own `tsc` so the compiler version matches CI, and links `.pi-mono` (git-ignored) to the located checkout because `tsconfig.json` extends pi-mono's. It covers runtime code only; test files, `scripts/` and `evals/` are excluded because they need Bun types.

## Pull requests

- Branch from `main` and keep one concern per PR.
- A behavior change comes with a test at the seam that fails without the change. Do not add tests for internals.
- Update `AGENTS.md` of the touched module when a constraint or contract changes; code is the source of truth, so docs only record what the code cannot show.
- CI (build, type check and `bun test`) must be green before review.
