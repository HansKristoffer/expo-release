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
     ├─ newest matching build errored → fail with EAS's error and the build link
     └─ no matching native build → eas build --auto-submit --no-wait
                                    (and name the fingerprint sources that changed)
```

## Install and requirements

```sh
bun add -D expo-release
bunx expo-release --help
```

The CLI and GitHub Action require Bun. EAS operations also need an authenticated Expo account and the EAS CLI in the calling project; Expo SDK 55+ OTA updates require an EAS environment (from `--environment` or the eas.json build profile). CI verifies Bun 1.4.2. Installing the npm package does not deploy an application.

In GitHub Actions, use the action (`uses: HansKristoffer/expo-release@v2`). It installs its own dependencies (`hanzio`, `zod`) in `${{ github.action_path }}` and runs `bun ${{ github.action_path }}/src/cli.ts`. The caller must already have checked out the repo (`fetch-depth: 0`), installed Bun and installed the workspace dependencies. Elsewhere, run the `expo-release` bin (see [CLI](#cli)).

`eas` and `expo` resolve to the app's own `node_modules/.bin` (searched from the working directory up to the repository root), then to `eas` on `PATH` and `bunx expo`. So the eas-cli version in the app's lockfile is the one that runs; pin it there, and `expo/expo-github-action` is no longer needed. `EAS_BIN` and `EXPO_BIN` override both. `EXPO_TOKEN` must reach the job.

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
   - channel and environment set on each EAS build profile we deploy, and the variant env vars in the profile's env
   - submit config in eas.json if we use auto-submit (iOS ascAppId, Android serviceAccountKeyPath from an EAS file secret, never a committed file)

3. Add .github/workflows/expo-release.yml using the HansKristoffer/expo-release@v2 composite action. Adapt consumer-specific values:
   - paths filter: Expo app dir, shared packages that affect the native bundle, and lockfile if native deps should trigger a release
   - working-directory and impact-paths pointing at the Expo app
   - profile for each deploy target (channel, environment and env come from eas.json)
   - workflow_dispatch inputs for force-native, retry-ota, republish, rollback-embedded
   - fetch-depth: 0 on checkout, the setup-workspace action, eas-cli pinned in the app devDependencies, and the EXPO_TOKEN secret
   - run `bunx expo-release doctor --profile <profile>` from the Expo app and fix what it reports

4. Document that EXPO_TOKEN must be added as a GitHub secret, and that the first run on a new fingerprint always queues a native build.

5. If we have staging + production (or multiple profiles), use separate jobs or a matrix with profile-specific concurrency groups.

6. Do not change unrelated CI. Keep the diff minimal and match existing workflow conventions in this repo.

Reference the upstream README for full input/output docs and recovery operations. Ask me only if a required value (Expo app path, deploy branch, profile names) cannot be inferred from the repo.
```

## Setup checklist

`expo-release doctor --profile <profile>`, run from the Expo app, checks most of this list.

- [ ] GitHub secret `EXPO_TOKEN` from https://expo.dev/settings/access-tokens
- [ ] `runtimeVersion: { policy: 'fingerprint' }` and `expo-updates` in the Expo app
- [ ] `eas.json` `channel` and `environment` on each build profile you deploy (production, staging, …), and the variables `app.config.ts` reads in its `env`
- [ ] `eas.json` submit config when you use `--auto-submit`:
  - iOS: `submit.<profile>.ios.ascAppId`
  - Android: `submit.<profile>.android.serviceAccountKeyPath`. Keep the key in an EAS file secret, not in git.
- [ ] EAS credentials (`eas credentials` from the Expo app directory). A new bundle identifier needs one interactive `eas credentials:configure-build --platform ios --profile <profile>` before CI can build it.
- [ ] No keystores, `.p8`/`.p12` files, provisioning profiles, service-account JSON, `.expo/` or logs in git. With continuous native generation, `android/` and `ios/` are gitignored too.
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
      EXPO_TOKEN: ${{ secrets.EXPO_TOKEN }}
    steps:
      - name: Checkout
        uses: actions/checkout@v5
        with:
          fetch-depth: 0
          clean: false        # keeps node_modules on a self-hosted runner

      # Bun from package.json packageManager, Node to match the eas.json
      # profile's `node`, the dependency cache and `bun install`. eas-cli comes
      # from the app's devDependencies.
      - name: Setup workspace
        uses: HansKristoffer/expo-release/.github/actions/setup-workspace@v2
        with:
          node-version: 22.12.0

      - name: Expo release
        uses: HansKristoffer/expo-release@v2
        with:
          command: release
          profile: production   # channel, environment and env come from eas.json
          operation: ${{ github.event.inputs.operation || 'deploy' }}
          impact-paths: apps/expo/
          working-directory: apps/expo
          group: ${{ github.event.inputs.group }}
          runtime-version: ${{ github.event.inputs.runtime-version }}
```

The release reads `build.<profile>` from `eas.json` in `working-directory` (following `extends`, like eas-cli): its `channel` is the default for `channel`; on Expo SDK 55+ its `environment` is the default for `environment` (before 55, `--environment` also turns off `.env` loading in `eas update`, so it is never added unasked); and each variable in its `env` that the job has not set is set for every EAS command and hook, as EAS sets them on the build machine. Inputs and variables you set win.

A manual `deploy` from `workflow_dispatch` ignores the impact diff. That is intentional: dispatch after an unrelated commit should still release, not silently skip.

### Action inputs

| Input | Default | Notes |
|-------|---------|--------|
| `command` | `release` | `release` (decide + operate), `decide` (PR checks), `operate`, or `doctor` |
| `profile` | `production` | EAS build profile. Its eas.json `channel`, `environment` and `env` are the defaults |
| `operation` | `deploy` | See recovery operations below |
| `deploy-type` | `none` | Used only when `command` is `operate` |
| `base` / `head` | merge base on a PR, else event before / `GITHUB_SHA` | Git range for the impact diff |
| `impact-paths` | `apps/expo/` | Comma-separated repo-root prefixes |
| `environment` | eas.json profile `environment` on SDK 55+ | Passed to `eas update`. Required for Expo SDK 55+ |
| `channel` | eas.json profile `channel`, else `profile` | EAS Update channel |
| `platform` | `ios` | `ios` or `android`. Passed through to `eas update` and `eas build` |
| `auto-submit` | `true` | Native builds use `--auto-submit` |
| `working-directory` | `apps/expo` | Where `eas` runs |
| `pre-update` | _(empty)_ | Shell command before `eas update` (OTA only) |
| `post-update` | _(empty)_ | Shell command after a successful `eas update` (OTA only) |
| `update-extra-args` | _(empty)_ | Extra arguments appended to `eas update`, split like a shell (quotes group) |
| `export-source-maps` | `false` | OTA only: `expo export --source-maps external`, refuse if `dist` has no `.map`, then `eas update --input-dir dist --skip-bundler`. Pair with `post-update` to upload those maps for PostHog error tracking. |
| `group` | _(empty)_ | Required when `operation` is `republish` |
| `runtime-version` | current fingerprint | Used when `operation` is `rollback-embedded` |
| `message` | `{profile} {sha} (fp {hash})` | Override the generated `eas update` message |
| `dry-run` | `false` | Print mutating EAS commands without executing them |

### Action outputs

| Output | Notes |
|--------|--------|
| `deploy_type` | Stable PR-check type: `none`, `ota`, `native` |
| `changed` | `true` unless `deploy_type` is `none` |
| `reason` | Why: `no-impact-path`, `finished-build`, `build-in-progress`, `no-build-for-fingerprint` |
| `changed_sources` | For a native decision: fingerprint sources changed since the profile's last finished build (`changed node_modules/expo-camera`), one per line |
| `native_build_pending` | `true` when a matching native build is still in progress |
| `fingerprint` | Current EAS fingerprint hash |
| `build_id` / `build_url` | Matching EAS build, if any |
| `queued_build_id` / `queued_build_url` | The native build operate queued, if any |
| `result` | Operate result (`skipped`, `ota`, `native-build`, `recovery`), or `failed` |
| `failed_stage` | On failure, the step: `fingerprint`, `build list`, `errored build`, `native build`, `ota export`, `ota update`, `pre-update`, `post-update`, `recovery`, `doctor` |
| `failure` | On failure, the last lines the command printed and a fixed next step for that stage |

### When a release fails

Every EAS command runs as a named stage, and the log shows how long each took. A failure ends with one annotation that names the stage, profile and platform and quotes EAS's last lines, for example `expo-release: native build failed (production, ios): Credentials are not set up.`, without a stack trace. The job summary repeats the last 20 lines and a next step chosen by stage, and `failed_stage` lets a workflow branch on the stage instead of matching EAS's wording.

When `eas fingerprint:generate` prints a warning before its JSON, the app config did not load and eas-cli fell back to its own `@expo/config`. The decision then fails and quotes `expo config`'s error, because that fingerprint may not be the one EAS builds with.

An errored build for the current fingerprint fails the run with EAS's error code and message and the build's dashboard link. Fix it, then dispatch `operation: force-native`.

### PR checks (decide only)

PR jobs usually only decide. Use `command: decide` and comment or gate on `deploy_type`. On a `pull_request` event `base` defaults to the merge base with the PR's base branch, so no merge-base step is needed:

```yaml
- uses: HansKristoffer/expo-release@v2
  id: decision
  with:
    command: decide
    profile: pr-preview   # or production
```

Then use `${{ steps.decision.outputs.deploy_type }}` (`none` / `ota` / `native`), `reason`, and for `native` the `changed_sources` that make it native. A PR comment built from them tells the author whether the change needs a store build. A PR job that does build can run `command: release` with `auto-submit: 'false'` and read `queued_build_url`.

The CLI writes the same JSON to stdout, including `deployType`:

```bash
bun "${{ github.action_path }}/src/cli.ts" decide \
  --base "$BASE" --head "$HEAD" --profile production
```

Every EAS command inherits the process env, including the profile's eas.json `env`. Variables that are not in the profile go on the **action step or the job**. When `app.config.ts` switches slug or bundle identifier on `APP_VARIANT`, every EAS command (`fingerprint:generate`, `build:list`, `eas build`, `eas update`) resolves a different project from that config, so keep it in the profile's `env`.

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
```

Override the Expo binary with `EXPO_BIN` (defaults to the app's `node_modules/.bin/expo`, else `bunx expo`). `--dry-run` prints the export command and skips the `.map` check.

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

### Doctor

`expo-release doctor --profile <profile>` (or `command: doctor`) prints one line per problem with its fix and exits 1 on an error:

- `eas.json` exists, has the build profile, the profile has a `channel`, and `submit.<profile>` exists when auto-submit is on
- an EAS environment is known for Expo SDK 55+
- eas-cli runs and satisfies `eas.json` `cli.version`; `EXPO_TOKEN` is set in CI
- the running Bun equals the profile's `bun` (error) and Node its `node` (warning)
- no credentials are committed (`*.keystore` except `debug.keystore`, `*.jks`, `*.p8`, `*.p12`, `*.mobileprovision`, service-account JSON), nor `.expo/` or `*.log`
- committed `android/` or `ios/` are not hidden by `.fingerprintignore`; with config plugins, committed native folders get a warning
- the app config loads and uses `runtimeVersion: { policy: 'fingerprint' }`

`decide` and `release` run the same checks, except the app config, before their first EAS call and print the findings as warnings without failing.

### Fingerprint config

EAS increments `ios.buildNumber` and `android.versionCode` remotely, so skip `ExpoConfigVersions` and add the app version back: a new store version then needs a native build, not an OTA. With continuous native generation, ignore the native folders so a local prebuild cannot change the fingerprint. `apps/expo/fingerprint.config.js`:

```js
const { version } = require('./package.json')

/** @type {import('@expo/fingerprint').Config} */
module.exports = {
  sourceSkips: [
    'ExpoConfigRuntimeVersionIfString',
    'ExpoConfigVersions',
    'PackageJsonAndroidAndIosScriptsIfNotContainRun'
  ],
  extraSources: [{ type: 'contents', id: 'appVersion', contents: version }],
  ignorePaths: ['ios/**/*', 'android/**/*']
}
```

Do not list `android` or `ios` in `.fingerprintignore` while they are committed: EAS builds the committed tree, and a change there would never queue a native build.

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

  staging:
    if: github.ref == 'refs/heads/develop'
    # ... setup steps ...
    steps:
      - uses: HansKristoffer/expo-release@v2
        with:
          profile: staging
```

### One job, matrix

```yaml
strategy:
  fail-fast: false
  matrix:
    include:
      - profile: production
      - profile: staging

steps:
  - uses: HansKristoffer/expo-release@v2
    with:
      profile: ${{ matrix.profile }}   # channel, environment, env from eas.json
```

`channel` defaults to the profile's eas.json `channel`, then to the profile name. Set `channel` only to publish somewhere the builds do not listen.

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

expo-release doctor --profile production [--platform ios] [--auto-submit true]
```

Run `expo-release <command> --help` for every flag. Each flag also reads `EXPO_RELEASE_<FLAG>` (for example `EXPO_RELEASE_IMPACT_PATHS`) when it is not passed; an empty value counts as unset.

`release` is decide + operate (same as the action default). `force-native`, `republish`, and `rollback-embedded` skip decide. `decide` prints JSON including `deployType`, `reason`, `nativeBuildPending` and, for `native`, `fingerprintDiff`. When `GITHUB_OUTPUT` is set, decide writes `deploy_type`, `reason`, `native_build_pending`, `changed`, `fingerprint`, `build_id`, `build_url`, `changed_sources`, `compared_build_url`. Operate writes `result`, `queued_build_id`, `queued_build_url`; a failure writes `result=failed`, `failed_stage` and `failure`.

```bash
# local (after bun add -D expo-release)
expo-release decide --base HEAD^ --head HEAD --profile production
```

## App runtime

`expo-release/runtime` has the app side of a release: OTA prompts, push notifications and a render-error boundary. Install the package as a dependency (not `-D`) to use it. `react`, `react-native`, `expo-updates`, `expo-notifications` and `expo-device` are optional peers; the CLI never needs them. The helpers render no UI: pass your toast, dialog and error screen.

### OTA updates

Checks once per launch, downloads a new update and hands you a `reload` for your "Restart" prompt, once per update. It is off in development and wherever expo-updates is disabled (Expo Go). An app that stays open for days should also check on foreground: `recheckOnForeground: 30` checks again when the app becomes active, at most every 30 minutes. A failed check goes to `onError`, by default `console.warn`.

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
    }),
    { recheckOnForeground: 30 }
  )
}
```

The callback is read through a ref, so an unstable toast function never repeats the check. `checkForOTAUpdate(onUpdateReady)` runs the same check outside React, for example from an error screen's "Update and restart" button.

`getReleaseInfo()` returns `{ updateId, runtimeVersion, channel, createdAt, isEmbeddedLaunch }` for the running release (nulls in Expo Go and for the embedded bundle). Attach it to crash reports and show it on a version screen.

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
| `enable()` / `disable()` | Settings toggle. `enable` requests permission and registers; `disable` calls `registerDevice(null)` and rejects when it does. Use `disable()` to turn push off (also on sign-out, in a `try`) so the token is not re-sent on the next launch. |
| `syncToken()` | Registers the current token when permission is granted. Call it after a later sign-in when the user's saved preference is on: `prompt()` asks only once per install, and `disable()` on sign-out removed the token. |
| `listen({ onReceived, onResponse })` | Subscribes and returns the unsubscribe function. `onResponse` also receives the tap that launched the app; each response is delivered once per app start, however often `listen` runs. Also keeps the token current: on start and whenever Expo rotates it, a token that differs from the last one sent is registered again. This runs only after a token was sent and `disable()` has not run since. Call it once at the root of the app. |
| `setAndroidChannel(channel)` | Recreates the Android `default` channel, for example with translated texts once i18n is ready. |
| `getPermissionStatus()`, `getPushToken()`, `requestPermissions()`, `hasPrompted()` | Lower-level steps. |

`usePushNotifications(push, { enabled, persist })` gives a settings screen `permission`, `isEnabled`, `isLoading` and wrapped `prompt`/`enable`/`disable`. `enabled` is the saved preference; while it is on, the token is re-registered on mount.

`persist` saves the preference, for example on the user's account. `enable()` and `disable()` call it first and show the new value right away. If it rejects, the hook restores `enabled`, skips the push step and rethrows, so catch it for your error toast. Saving before `enable()` means a denied dialog leaves the preference on with `isEnabled` false; the token registers on the next mount once permission is granted in device settings. Without `persist`, save the preference yourself before calling `enable()`.

```tsx
const { isEnabled, isLoading, enable, disable } = usePushNotifications(push, {
  enabled: user.pushEnabled,
  persist: (pushEnabled) => api.user.update({ pushEnabled })
})

const onToggle = async (on: boolean) => {
  try {
    if (!on) return await disable()
    if (!(await enable())) toast('Allow notifications in device settings')
  } catch {
    toast('Could not save your notification setting')
  }
}
```

### Error boundary

```tsx
import { ErrorBoundary, getReleaseInfo } from 'expo-release/runtime'

<ErrorBoundary
  fallback={({ error, reset }) => <ErrorScreen message={error.message} onRetry={reset} />}
  onError={(error, info) =>
    posthog.captureException(error, {
      $exception_source: 'error_boundary',
      component_stack: info.componentStack,
      ...getReleaseInfo()
    })
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
| `setup-workspace` | Bun (version from `package.json` `packageManager` by default), optional Node, restore the dependency cache keyed on the OS, architecture and `bun.lock`, always `bun install --frozen-lockfile`, save on a miss with `save-cache: 'true'` (a failed save is a warning). `cache-paths` and `cache-key-files` are inputs. `env` on the `uses:` step reaches `bun install` and its postinstall scripts (a `DATABASE_URL` for a generated client, say). On a self-hosted runner it keeps `cache-paths` instead (see below). |
| `playwright-browsers` | Restores browsers for the installed Playwright version and architecture; installs and saves on a miss. A self-hosted runner skips the cache and keeps `~/.cache/ms-playwright`. |
| `pr-preview` | Railway preview environment per PR with its own PlanetScale Postgres branch and a Cloudflare-managed host. Creates on open/sync, deletes on close. It first checks every input and each provider's access and names each problem in its own annotation; a failed delete fails the job. The Railway CLI goes into the job's `$RUNNER_TEMP`. |
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

### Self-hosted runners

A self-hosted runner keeps its workspace between jobs, so these actions keep what a hosted VM would restore. Check out with `clean: false`; `setup-workspace` then removes every untracked file except `cache-paths` and `keep-paths`, skips the cache, and skips `bun install` when the files named by `install-key-paths` and the Bun version are unchanged since that runner's last install and every `cache-paths` entry without a glob still exists. When a checkout without `clean: false` wiped `node_modules`, it says so in a notice. Add the files a postinstall reads:

```yaml
      - uses: actions/checkout@v5
        with:
          clean: false
      - uses: HansKristoffer/expo-release/.github/actions/setup-workspace@v2
        with:
          cache-paths: |
            node_modules
            packages/*/node_modules
            apps/*/node_modules
            packages/prisma/generated
          keep-paths: .buncargo/typecheck-timings.json
          install-key-paths: |
            bun.lock
            *package.json
            patches
            packages/prisma/schema
```

On a self-hosted runner the release action points `TMPDIR` at the job's `runner.temp` when the job has not set it, so Metro's cache never collides with another user's `/tmp/metro-cache` (`EACCES`).

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

The action needs Cloudflare DNS for the preview host; a Railway-generated domain is not supported yet. Requirements: a PlanetScale **Postgres** database with a service token scoped to it (`read_branch`, `create_branch`, `delete_branch`, `create_branch_password`); a Railway account API token; a Cloudflare token with Zone.DNS Edit and the zone's SSL/TLS mode set to Full. Extensions such as `vector` must be enabled on the source branch.

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
