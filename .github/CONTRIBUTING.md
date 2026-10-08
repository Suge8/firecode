# Contributing

FireCode is a [Pi](https://github.com/earendil-works/pi) extension. Please open an issue before starting a large change.

## Setup

Tests and the type check run against the Pi sources, not an installed package. You need [Bun](https://bun.sh) and a checkout of pi-mono at the tag CI uses (see `PI_VERSION` in `.github/workflows/ci.yml`, currently `v1.1.0`) with its dependencies installed:

```bash
git clone --depth 1 --branch v1.1.0 https://github.com/earendil-works/pi ../pi
npm ci --ignore-scripts --prefix ../pi
export PI_PACKAGES_DIR="$PWD/../pi/packages"   # not needed if a dev build of `pi` from that checkout is on PATH
ln -s "$PWD/../pi" .pi-mono                      # used by tsconfig.json; git-ignored
```

## Checks

```bash
bun test
.pi-mono/node_modules/.bin/tsc --noEmit
```

Use pi-mono's `tsc` (`.pi-mono/node_modules/.bin/tsc`) so the compiler version matches CI. The type check covers runtime code only; test files and `evals/` are excluded because they need Bun types.

## Pull requests

- Branch from `main` and keep one concern per PR.
- A behavior change comes with a test at the seam that fails without the change. Do not add tests for internals.
- Update `AGENTS.md` of the touched module when a constraint or contract changes; code is the source of truth, so docs only record what the code cannot show.
- CI (type check and `bun test`) must be green before review.
