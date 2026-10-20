# expo-release

Fingerprint-driven Expo releases: compare the current EAS fingerprint to **existing native builds**, then either publish an OTA or queue a native build (optionally auto-submitted to TestFlight or Play).

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
     ├─ newest matching build errored → fail (use force-native after fixing)
     └─ no matching native build → eas build --auto-submit --no-wait
```

## Install and requirements

```sh
bun add -D expo-release
bunx expo-release --help
```

The CLI and GitHub Action require Bun. EAS operations also need an authenticated Expo account and the EAS CLI in the calling project; Expo SDK 55+ OTA updates require an explicit EAS environment. CI verifies Bun 1.4.2. Installing the npm package does not deploy an application.

## Set up with AI

Copy the prompt below into Cursor, Claude Code, or another coding agent to wire up expo-release in your existing repo.

```
Integrate expo-release (https://github.com/HansKristoffer/expo-release) into this codebase for fingerprint-driven Expo EAS releases.

Goal: on push to the main deploy branch, when Expo-related paths change, automatically publish an OTA update if a finished native build matches the current fingerprint, or queue a native store build (with auto-submit) when no matching build exists.

Do the following in this repo:

1. Inspect the repo layout: find the Expo app directory, monorepo package manager (bun/npm/pnpm), lockfile location, EAS profiles in eas.json, and any app.config.ts variant env vars (e.g. APP_VARIANT, SECRETS_ENV, APS_ENVIRONMENT).

2. Ensure the Expo app is ready for fingerprint-based updates:
   - runtimeVersion: { policy: 'fingerprint' } in app config
   - expo-updates installed and configured
   - channel set on each EAS build profile we deploy
   - submit config in eas.json if we use auto-submit (iOS ascAppId, Android serviceAccountKeyPath)

3. Add .github/workflows/expo-release.yml using the HansKristoffer/expo-release@v2 composite action. Adapt consumer-specific values:
   - paths filter: Expo app dir, shared packages that affect the native bundle, and lockfile if native deps should trigger a release
   - working-directory and impact-paths pointing at the Expo app
   - profile, environment, and channel for each deploy target
   - env vars required by app.config.ts on the action step (APP_VARIANT, etc.)
   - workflow_dispatch inputs for force-native, retry-ota, republish, rollback-embedded
   - fetch-depth: 0 on checkout, Bun/Node setup, dependency install, expo/expo-github-action with pinned eas-version and EXPO_TOKEN secret

4. Document that EXPO_TOKEN must be added as a GitHub secret, and that the first run on a new fingerprint always queues a native build.

5. If we have staging + production (or multiple profiles), use separate jobs or a matrix with profile-specific concurrency groups.

6. Do not change unrelated CI. Keep the diff minimal and match existing workflow conventions in this repo.

Reference the upstream README for full input/output docs and recovery operations. Ask me only if a required value (Expo app path, deploy branch, profile names) cannot be inferred from the repo.
```

## Install

### GitHub Action

```yaml
uses: HansKristoffer/expo-release@v2
```

The action runs `bun ${{ github.action_path }}/src/cli.ts`. The caller must already have checked out the repo (`fetch-depth: 0`), installed Bun, set up EAS, and installed workspace dependencies.

### npm (CLI)

For local use or custom CI:

```bash
bun add -D expo-release
```

Then run `expo-release` (see [CLI](#cli)).

Pin `eas-cli` with `expo/expo-github-action`. The CLI invokes `eas` from `PATH` (override with `EAS_BIN` for local tests), so that pin is the version that actually runs.

## Setup checklist

- [ ] GitHub secret `EXPO_TOKEN` from https://expo.dev/settings/access-tokens
- [ ] `runtimeVersion: { policy: 'fingerprint' }` and `expo-updates` in the Expo app
- [ ] `eas.json` channel on each profile you deploy (production, staging, …)
- [ ] `eas.json` submit config when you use `--auto-submit`:
  - iOS: `submit.<profile>.ios.ascAppId`
  - Android: `submit.<profile>.android.serviceAccountKeyPath`
- [ ] EAS credentials (`eas credentials` from the Expo app directory)
- [ ] At least one finished native build **per profile and platform** on the current fingerprint. The first run against a new app always queues a native build.
- [ ] `--environment` on every OTA for Expo SDK 55+
- [ ] Add lockfiles (`bun.lock`, `package-lock.json`) to `impact-paths` if a dependency bump should trigger a fingerprint check. The default `apps/expo/` path does not include the workspace lockfile.

## GitHub Action

Copy this workflow into `.github/workflows/expo-release.yml`. Replace the marked consumer-specific bits.

```yaml
# =============================================================================
# Expo Release
# =============================================================================
# Fingerprint decides OTA vs native store build. Push to main deploys production
# when Expo paths change. Manual dispatch can force a native build or recover
# an OTA.
# =============================================================================

name: Expo Release

on:
  push:
    branches: [main]
    paths:
      - apps/expo/**          # consumer: also list shared packages if needed
      - bun.lock              # consumer: include if lockfile changes native deps
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
          - republish
          - rollback-embedded
      group:
        description: Update group ID (required for republish)
        required: false
        type: string
      runtime-version:
        description: Runtime version (optional for rollback-embedded)
        required: false
        type: string

concurrency:
  group: expo-release-production-${{ github.ref }}
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  release:
    name: production
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

      - name: Expo release
        uses: HansKristoffer/expo-release@v2
        with:
          command: release
          profile: production
          operation: ${{ github.event.inputs.operation || 'deploy' }}
          environment: production
          impact-paths: apps/expo/
          working-directory: apps/expo
          group: ${{ github.event.inputs.group }}
          runtime-version: ${{ github.event.inputs.runtime-version }}
        env:
          # Set variant keys on the action step (or the job). They must reach
          # fingerprint:generate, build:list, eas build, and eas update.
          APP_VARIANT: production
          SECRETS_ENV: production
          APS_ENVIRONMENT: production
```

A manual `deploy` from `workflow_dispatch` ignores the impact diff. That is intentional: dispatch after an unrelated commit should still release, not silently skip.

### Action inputs

| Input | Default | Notes |
|-------|---------|--------|
| `command` | `release` | `release` (decide + operate), `decide` (PR checks), or `operate` |
| `profile` | `production` | EAS build profile; default update channel |
| `operation` | `deploy` | See recovery operations below |
| `deploy-type` | `none` | Used only when `command` is `operate` |
| `base` / `head` | event before / `GITHUB_SHA` | Git range for the impact diff |
| `impact-paths` | `apps/expo/` | Comma-separated repo-root prefixes |
| `environment` | _(empty)_ | Passed to `eas update`. Required for Expo SDK 55+ |
| `channel` | same as `profile` | EAS Update channel |
| `platform` | `ios` | `ios` or `android`. Passed through to `eas update` and `eas build` |
| `auto-submit` | `true` | Native builds use `--auto-submit` |
| `working-directory` | `apps/expo` | Where `eas` runs |
| `pre-update` | _(empty)_ | Shell command before `eas update` (OTA only) |
| `post-update` | _(empty)_ | Shell command after a successful `eas update` (OTA only) |
| `update-extra-args` | _(empty)_ | Extra tokens appended to `eas update` |
| `export-source-maps` | `false` | OTA only: `expo export --source-maps external`, refuse if `dist` has no `.map`, then `eas update --input-dir dist --skip-bundler`. Pair with `post-update` to upload those maps for PostHog error tracking. |
| `group` | _(empty)_ | Required when `operation` is `republish` |
| `runtime-version` | current fingerprint | Used when `operation` is `rollback-embedded` |
| `message` | `{profile} {sha} (fp {hash})` | Override the generated `eas update` message |
| `dry-run` | `false` | Print mutating EAS commands without executing them |

### Action outputs

| Output | Notes |
|--------|--------|
| `deploy_type` | Stable PR-check type: `none`, `ota`, `native` |
| `native_build_pending` | `true` when a matching native build is still in progress |
| `fingerprint` | Current EAS fingerprint hash |
| `build_id` / `build_url` | Matching EAS build, if any |
| `result` | Operate result (`skipped`, `ota`, `native-build`, `recovery`) |

### PR checks (decide only)

PR jobs should not operate. Use `command: decide` and comment or gate on `deploy_type`:

```yaml
- uses: HansKristoffer/expo-release@v2
  id: decision
  with:
    command: decide
    profile: pr-preview   # or production
    base: ${{ steps.merge-base.outputs.sha }}
    head: ${{ github.sha }}
  env:
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

`Bun.spawn` inherits process env. Set variant keys on the **action step or the job**, never on decide alone. When `app.config.ts` switches slug or bundle identifier on `APP_VARIANT`, every EAS command (`fingerprint:generate`, `build:list`, `eas build`, `eas update`) resolves a different project from that config.

### OTA hooks

`pre-update`, `post-update`, and `update-extra-args` run only on the OTA path (`deploy` + `ota`, and `retry-ota`). Skip, native builds, republish, and rollback ignore them. Hook commands inherit process env. A non-zero hook exit fails operate; `post-update` does not run if `eas update` fails.

`export-source-maps` is the shared Hermes export. Set it only on profiles that should publish a pre-exported `dist` (usually production). Staging stays a default `eas update`.

Use it with PostHog error tracking: the same `dist` bundle that goes to `eas update` contains the Hermes `.map` files PostHog needs to symbolicate production crashes. Upload them in `post-update` after a successful OTA (`POSTHOG_CLI_API_KEY`, `POSTHOG_CLI_PROJECT_ID`, and `POSTHOG_CLI_HOST` must reach the action step):

```yaml
- uses: HansKristoffer/expo-release@v2
  with:
    command: release
    profile: production
    environment: production
    export-source-maps: 'true'
    post-update: bunx posthog-cli hermes upload --directory dist
  env:
    APP_VARIANT: production
    SECRETS_ENV: production
    APS_ENVIRONMENT: production
```

Override the Expo binary with `EXPO_BIN` (defaults to `bunx expo`). `--dry-run` prints the export command and skips the `.map` check.

### Recovery operations

| Operation | Effect |
|-----------|--------|
| `deploy` | Same as a push: decide, then OTA or native build |
| `force-native` | Queue a native build (skip decide). Use this after fixing a failed fingerprint build. |
| `retry-ota` | Publish an OTA even if the diff has no impact paths |
| `republish` | `eas update:republish --group <id>`. Copy the group ID from the Expo dashboard. |
| `rollback-embedded` | `eas update:roll-back-to-embedded` with `--runtime-version` (defaults to the current fingerprint) |

### Dry run

`--dry-run` still runs `git diff`, `eas fingerprint:generate`, and `eas build:list` so the decision is real. It only prints `eas update`, `eas build`, recovery commands, `expo export` (when `export-source-maps` is on), and OTA hooks.

```yaml
- uses: HansKristoffer/expo-release@v2
  with:
    command: release
    profile: production
    environment: production
    dry-run: 'true'
```

## Multiple apps (staging and production)

Use one job per profile, or a matrix. Each profile needs its own finished native build before OTAs work. One `EXPO_TOKEN` covers multiple projects under the same Expo account; separate accounts or orgs need separate secrets.

Put the **profile in the concurrency group**. Two profiles deploying from the same ref should not serialize:

```yaml
concurrency:
  group: expo-release-${{ matrix.profile }}-${{ github.ref }}
  cancel-in-progress: false
```

### Two jobs, one branch each

```yaml
on:
  push:
    branches: [main, develop]

jobs:
  production:
    if: github.ref == 'refs/heads/main'
    # ... setup steps ...
    steps:
      - uses: HansKristoffer/expo-release@v2
        with:
          profile: production
          environment: production
          channel: production
        env:
          APP_VARIANT: production

  staging:
    if: github.ref == 'refs/heads/develop'
    # ... setup steps ...
    steps:
      - uses: HansKristoffer/expo-release@v2
        with:
          profile: staging
          environment: staging
          channel: staging
        env:
          APP_VARIANT: staging
```

### One job, matrix

```yaml
strategy:
  fail-fast: false
  matrix:
    include:
      - profile: production
        environment: production
        variant: production
      - profile: staging
        environment: staging
        variant: staging

steps:
  - uses: HansKristoffer/expo-release@v2
    with:
      profile: ${{ matrix.profile }}
      environment: ${{ matrix.environment }}
      channel: ${{ matrix.profile }}
    env:
      APP_VARIANT: ${{ matrix.variant }}
```

`channel` defaults to `profile`. If two profiles should publish to the same channel, set `channel` explicitly and keep `profile` as the EAS build profile.

## CLI

```bash
expo-release release \
  --base <sha> --head <sha> --profile production \
  [--platform ios] \
  [--impact-paths apps/expo/,packages/conductor/] \
  [--environment production] \
  [--dry-run]

expo-release decide \
  --base <sha> --head <sha> --profile production \
  [--platform ios] \
  [--impact-paths apps/expo/,packages/conductor/] \
  [--ignore-expo-impact true]

expo-release operate \
  --profile production \
  --deploy-type <none|ota|native> \
  --operation <deploy|force-native|retry-ota|republish|rollback-embedded> \
  [--channel production] [--environment production] \
  [--platform ios] [--auto-submit true] \
  [--group <update-group-id>] \
  [--runtime-version <hash>] \
  [--message "custom message"] \
  [--export-source-maps true] \
  [--pre-update "bun scripts/release/tag-dist.ts"] \
  [--update-extra-args "--private-key-path key"] \
  [--post-update "bunx posthog-cli hermes upload --directory dist"]
```

`release` is decide + operate (same as the action default). `force-native`, `republish`, and `rollback-embedded` skip decide. `decide` prints JSON including `deployType` and `nativeBuildPending`. When `GITHUB_OUTPUT` is set, decide writes `deploy_type`, `native_build_pending`, `changed`, `fingerprint`, `build_id`, `build_url`. Operate writes `result`.

```bash
# local (after bun add -D expo-release)
expo-release decide --base HEAD^ --head HEAD --profile production
```

## App runtime

`expo-release/runtime` has the app side of a release: OTA prompts, push notifications and a render-error boundary. Install the package as a dependency (not `-D`) to use it. `react`, `expo-updates`, `expo-notifications` and `expo-device` are optional peers; the CLI never needs them. The helpers render no UI: pass your toast, dialog and error screen.

### OTA updates

Checks once per launch, downloads a new update and hands you a `reload` for your "Restart" prompt. It is off in development and wherever expo-updates is disabled (Expo Go).

```tsx
import { useOTAUpdates } from 'expo-release/runtime'

function AppContent() {
  const { toast } = useToast()
  useOTAUpdates((reload) =>
    toast.show({
      id: 'ota-update-available',
      label: 'Update ready',
      description: 'A new version downloaded. Tap Restart to apply.',
      actionLabel: 'Restart',
      onActionPress: reload
    })
  )
}
```

The callback is read through a ref, so an unstable toast function never repeats the check. `checkForOTAUpdate(onUpdateReady)` runs the same check outside React.

### Push notifications

Create the service once. It sets the foreground handler and the Android `default` channel, and owns the permission flow and the Expo push token. Your backend call is `registerDevice` (`null` unregisters).

```ts
import AsyncStorage from '@react-native-async-storage/async-storage'
import { Alert } from 'react-native'
import { createPushNotifications } from 'expo-release/runtime'

export const push = createPushNotifications({
  storage: AsyncStorage,
  registerDevice: (expoPushToken) =>
    api.user.registerDevice({ platform: Platform.OS, expoPushToken }),
  // Optional soft-ask before the OS dialog.
  confirm: () =>
    new Promise((resolve) =>
      Alert.alert('Turn on alerts?', 'Get notified about new messages.', [
        { text: 'Not now', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Enable', onPress: () => resolve(true) }
      ])
    ),
  onUnavailable: (reason) => {
    if (reason === 'denied') Alert.alert('Notifications off', 'Turn them on in device settings.')
  },
  onError: (message, error) => logger.error(message, error)
})
```

| Member | Use |
|--------|-----|
| `prompt()` | After sign-in. Asks once per install (soft-ask, then OS dialog), registers the token on a grant. Never throws; concurrent calls share one dialog. |
| `enable()` / `disable()` | Settings toggle. `enable` requests permission and registers; `disable` calls `registerDevice(null)`. Save the user's preference yourself. |
| `syncToken()` | Re-registers the current token when permission is granted. |
| `listen({ onReceived, onResponse })` | Subscribes and returns the unsubscribe function. `onResponse` also receives the tap that launched the app. |
| `getPermissionStatus()`, `getPushToken()`, `requestPermissions()`, `hasPrompted()` | Lower-level steps. |

`usePushNotifications(push, { enabled })` gives a settings screen `permission`, `isEnabled`, `isLoading` and wrapped `prompt`/`enable`/`disable`. `enabled` is the saved preference; while it is on, the token is re-registered on mount.

### Error boundary

```tsx
import { ErrorBoundary } from 'expo-release/runtime'

<ErrorBoundary
  fallback={({ error, reset }) => <ErrorScreen message={error.message} onRetry={reset} />}
  onError={(error, info) =>
    posthog.captureException(error, { $exception_source: 'error_boundary', component_stack: info.componentStack })
  }
>
  <App />
</ErrorBoundary>
```

Report errors in `onError`: render errors are caught before they become uncaught exceptions, so error-tracking autocapture never sees them.

## Workspace and PR actions

Composite actions for Bun monorepos, used as `HansKristoffer/expo-release/.github/actions/<name>@v2`. Pass secrets as inputs.

| Action | Does |
|--------|------|
| `setup-workspace` | Bun (version from `package.json` `packageManager` by default), optional Node, restore the dependency cache keyed on `bun.lock`, always `bun install --frozen-lockfile`, save on a miss with `save-cache: 'true'`. `cache-paths` and `cache-key-files` are inputs. |
| `playwright-browsers` | Restores browsers for the installed Playwright version; installs and saves on a miss. |
| `pr-preview` | Railway preview environment per PR with its own PlanetScale Postgres branch and a Cloudflare-managed host. Creates on open/sync, deletes on close. |
| `ai-changelog` | Plain-language changelog of a pushed range with Claude; outputs `message` (chat) and `markdown`, optionally POSTs the message to a webhook. |

### Warm the caches on main

Caches written by `pull_request` runs are scoped to that PR. Warm them on main so every new PR starts from a hit:

```yaml
name: Cache Warm
on:
  push:
    branches: [main]
  workflow_dispatch:
concurrency:
  group: cache-warm
  cancel-in-progress: true
permissions:
  contents: read
jobs:
  warm:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v5
      - uses: HansKristoffer/expo-release/.github/actions/setup-workspace@v2
        with:
          save-cache: 'true'
          cache-paths: |   # consumer: add generated clients
            node_modules
            packages/*/node_modules
            apps/*/node_modules
      - uses: HansKristoffer/expo-release/.github/actions/playwright-browsers@v2
        with:
          working-directory: apps/platform
```

Use the same `cache-paths` in every job, since they are part of the cache version.

### PR preview environments

The preview duplicates `railway-source-environment` (default `staging`) into `pr-<number>`, points git-connected services at the PR branch, sets `DATABASE_URL` and `DATABASE_URL_DIRECT` to a fresh PlanetScale branch, attaches `pr-<number>.<zone>` with Cloudflare DNS, then sets `BASE_URL`, which triggers the one deployment (run migrations and seeds in your pre-deploy step).

```yaml
name: PR preview
on:
  pull_request:
    types: [opened, reopened, synchronize, closed]
concurrency:
  group: pr-preview-${{ github.event.number }}
  cancel-in-progress: false
permissions:
  contents: read
jobs:
  preview:
    # Fork PRs cannot read the secrets.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - uses: HansKristoffer/expo-release/.github/actions/pr-preview@v2
        with:
          planetscale-org: ${{ secrets.PLANETSCALE_ORG_NAME }}
          planetscale-database: my-app-staging
          planetscale-service-token-id: ${{ secrets.PLANETSCALE_SERVICE_TOKEN_ID }}
          planetscale-service-token: ${{ secrets.PLANETSCALE_SERVICE_TOKEN }}
          railway-token: ${{ secrets.RAILWAY_STAGING_TOKEN }}
          railway-project-id: ${{ secrets.RAILWAY_STAGING_PROJECT_ID }}
          railway-service: ${{ secrets.RAILWAY_STAGING_SERVICE }}
          cloudflare-api-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          cloudflare-zone-id: ${{ secrets.CLOUDFLARE_ZONE_ID }}
          cloudflare-zone-name: previews.example.com
```

Requirements: a PlanetScale **Postgres** database with a service token scoped to it (`read_branch`, `create_branch`, `delete_branch`, `create_branch_password`); a Railway account API token; a Cloudflare token with Zone.DNS Edit and the zone's SSL/TLS mode set to Full. Extensions such as `vector` must be enabled on the source branch.

### AI changelog

```yaml
name: Changelog
on:
  push:
    branches: [main]
jobs:
  changelog:
    if: "!contains(github.event.head_commit.message, '[skip ci]')"
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: read
      pull-requests: read
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: HansKristoffer/expo-release/.github/actions/ai-changelog@v2
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          webhook-url: ${{ secrets.CHANGELOG_WEBHOOK_URL }}
          webhook-token: ${{ secrets.CHANGELOG_WEBHOOK_TOKEN }}
          webhook-payload: '{"groupId": "${{ secrets.CHANGELOG_GROUP_ID }}"}'
```

Without `webhook-url`, read `steps.<id>.outputs.message` and `outputs.markdown` yourself. `chat-format` sets the message style (WhatsApp by default) and `instructions` adds audience or product context.

## Releasing

Squash PRs with conventional titles (`fix:`, `feat:`, or `feat!:`). Release Please keeps the version and changelog in a release PR; merge that PR to publish with release notes and npm provenance. See [release and recovery instructions](docs/releasing.md).
