# expo-release

Fingerprint-driven Expo releases: compare the current EAS fingerprint to **existing native iOS builds**, then either publish an OTA or queue a native build (optionally auto-submitted to TestFlight).

This is not “last OTA on the channel vs current fingerprint.” A new runtime needs a matching native binary before installs can receive OTAs for that fingerprint.

```
Push / dispatch
     │
     ▼
decide — git diff + eas fingerprint:generate + eas build:list
     │
     ├─ no matching impact paths → skip
     ├─ finished native build with this fingerprint → eas update
     ├─ matching native build in progress → OTA only
     └─ no matching native build → eas build --auto-submit --no-wait
```

## Install

```bash
bun add -d expo-release
```

Or use the composite action without publishing:

```yaml
uses: HansKristoffer/expo-release@v1
```

The action runs `bun ${{ github.action_path }}/src/cli.ts`. The caller must already have checked out the repo (`fetch-depth: 0`), installed Bun, set up EAS, and installed workspace dependencies.

## Setup checklist

- [ ] GitHub secret `EXPO_TOKEN` from https://expo.dev/settings/access-tokens
- [ ] `runtimeVersion: { policy: 'fingerprint' }` and `expo-updates` in the Expo app
- [ ] `eas.json` channel on the production (or staging) profile
- [ ] `eas.json` `submit.production.ios.ascAppId` if you use `--auto-submit`
- [ ] EAS iOS credentials (`eas credentials` from the Expo app directory)
- [ ] At least one finished production iOS build on the current fingerprint, or the first run will queue a native build

## GitHub Action

Copy this workflow into `.github/workflows/expo-release.yml`. Replace the marked consumer-specific bits.

```yaml
# =============================================================================
# Expo Release
# =============================================================================
# Fingerprint decides OTA vs native TestFlight. Push to main deploys production
# when Expo paths change. Manual dispatch can force a native build or recover
# an OTA.
# =============================================================================

name: Expo Release

on:
  push:
    branches: [main]
    paths:
      - apps/expo/**          # consumer: also list shared packages if needed
  workflow_dispatch:
    inputs:
      operation:
        description: Recovery/deployment operation
        required: true
        default: deploy
        type: choice
        options:
          - deploy
          - force-native
          - retry-ota
          - republish-latest
          - rollback-embedded

concurrency:
  group: expo-release-${{ github.ref }}
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  release:
    name: production iOS
    runs-on: ubuntu-latest
    timeout-minutes: 45
    env:
      # consumer: only if app.config.ts requires public URLs at eval time
      EXPO_PUBLIC_API_URL: https://example.com
      EXPO_PUBLIC_PLATFORM_URL: https://example.com
    steps:
      - name: Checkout
        uses: actions/checkout@v7
        with:
          fetch-depth: 0

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version-file: .bun-version

      - name: Setup Node
        uses: actions/setup-node@v7
        with:
          node-version: 22.12.0

      - name: Restore Bun workspace cache
        uses: actions/cache@v6
        with:
          path: |
            node_modules
            packages/*/node_modules
            apps/*/node_modules
          key: ${{ runner.os }}-bun-${{ hashFiles('bun.lock') }}
          restore-keys: |
            ${{ runner.os }}-bun-

      - name: Setup Expo and EAS
        uses: expo/expo-github-action@v8
        with:
          eas-version: 16.32.0
          token: ${{ secrets.EXPO_TOKEN }}

      - name: Install dependencies
        run: bun install --frozen-lockfile

      # consumer: omit if the Expo app does not typecheck Prisma
      - name: Generate Prisma client
        run: bun run prisma:generate
        env:
          DATABASE_URL: postgresql://placeholder:placeholder@localhost:5432/placeholder

      - name: Typecheck Expo
        working-directory: apps/expo
        run: bun run typecheck
        env:
          NODE_OPTIONS: --max-old-space-size=4096

      - name: Expo release
        uses: HansKristoffer/expo-release@v1
        with:
          command: release                 # default: decide + operate
          profile: production
          operation: ${{ github.event.inputs.operation || 'deploy' }}
          environment: production          # consumer: omit if eas update should not set --environment
          impact-paths: apps/expo/         # consumer: apps/expo/,packages/conductor/
          working-directory: apps/expo
```

### Action inputs

| Input | Default | Notes |
|-------|---------|--------|
| `command` | `release` | `release` (decide + operate), `decide` (PR checks), or `operate` |
| `profile` | `production` | EAS build profile; default update channel |
| `operation` | `deploy` | See recovery operations below |
| `action` | `skip` | Used only when `command` is `operate` |
| `base` / `head` | event before / `GITHUB_SHA` | Git range for the impact diff |
| `impact-paths` | `apps/expo/` | Comma-separated repo-root prefixes |
| `environment` | _(empty)_ | Passed to `eas update` only when set |
| `channel` | same as `profile` | EAS Update channel |
| `platform` | `ios` | `ios` or `android` |
| `auto-submit` | `true` | Native builds use `--auto-submit` |
| `working-directory` | `apps/expo` | Where `eas` runs |

### Action outputs

| Output | Notes |
|--------|--------|
| `action` | Internal decision: `skip`, `ota`, `build`, `build-in-progress` |
| `deploy_type` | Stable PR-check type: `none`, `ota`, `native` |
| `fingerprint` | Current EAS fingerprint hash |
| `build_id` / `build_url` | Matching EAS build, if any |
| `result` | Operate result (`skipped`, `ota`, `native-build`, `recovery`) |

`deploy_type` maps `skip` → `none`, `ota` and `build-in-progress` → `ota`, and `build` → `native`.

### PR checks (decide only)

PR jobs should not operate. Use `command: decide` and comment or gate on `deploy_type`:

```yaml
- uses: HansKristoffer/expo-release@v1
  id: decision
  with:
    command: decide
    profile: pr-preview   # or production
    base: ${{ steps.merge-base.outputs.sha }}
    head: ${{ github.sha }}
  env:
    # optional — inherited by eas fingerprint:generate
    APP_VARIANT: staging
    SECRETS_ENV: staging
    APS_ENVIRONMENT: production
```

Then use `${{ steps.decision.outputs.deploy_type }}` (`none` / `ota` / `native`).

The CLI writes the same JSON to stdout, including `deployType`:

```bash
bun "${{ github.action_path }}/src/cli.ts" decide \
  --base "$BASE" --head "$HEAD" --profile production
```

`Bun.spawn` inherits process env. Set variant keys on the decide step when the fingerprint must match a specific binary (for example staging vs production). Apps that do not branch on those variables set nothing extra.

### Recovery operations

| Operation | Effect |
|-----------|--------|
| `deploy` | Same as a push: decide, then OTA or native build |
| `force-native` | Queue a native build (skip decide) |
| `retry-ota` | Publish an OTA even if the diff has no impact paths |
| `republish-latest` | `eas update:republish` on the channel |
| `rollback-embedded` | `eas update:roll-back-to-embedded` |

## CLI

```bash
expo-release release \
  --base <sha> --head <sha> --profile production \
  [--platform ios] \
  [--impact-paths apps/expo/,packages/conductor/]

expo-release decide \
  --base <sha> --head <sha> --profile production \
  [--platform ios] \
  [--impact-paths apps/expo/,packages/conductor/] \
  [--ignore-expo-impact true]

expo-release operate \
  --profile production \
  --action <skip|ota|build|build-in-progress> \
  --operation <deploy|force-native|retry-ota|republish-latest|rollback-embedded> \
  [--channel production] [--environment production] \
  [--platform ios] [--auto-submit true]
```

`release` is decide + operate (same as the action default). `decide` prints JSON including `action` and `deployType`. When `GITHUB_OUTPUT` is set, decide writes `action`, `deploy_type`, `changed`, `fingerprint`, `build_id`, `build_url`. Operate writes `result`.

```bash
# local
bunx expo-release decide --base HEAD^ --head HEAD --profile production
```
