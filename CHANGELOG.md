# Changelog

## [2.4.0](https://github.com/HansKristoffer/expo-release/compare/v2.3.2...v2.4.0) (2026-11-12)


### Features

* **cli:** add expo-release doctor and run its quick checks before decide ([8f9e769](https://github.com/HansKristoffer/expo-release/commit/8f9e7691d4c4c631c037b35c1117318ae4597b82))
* **cli:** default channel, environment and env from the eas.json build profile ([8f9e769](https://github.com/HansKristoffer/expo-release/commit/8f9e7691d4c4c631c037b35c1117318ae4597b82))
* **cli:** name the failed stage, quote EAS's last lines in one annotation and the job summary, write result=failed and failed_stage ([8f9e769](https://github.com/HansKristoffer/expo-release/commit/8f9e7691d4c4c631c037b35c1117318ae4597b82))
* **cli:** run the app's own eas and expo binaries ahead of PATH ([8f9e769](https://github.com/HansKristoffer/expo-release/commit/8f9e7691d4c4c631c037b35c1117318ae4597b82))
* **decide:** output reason and, for a native decision, the fingerprint sources changed since the last finished build ([8f9e769](https://github.com/HansKristoffer/expo-release/commit/8f9e7691d4c4c631c037b35c1117318ae4597b82))
* **operate:** output the queued native build and default base to the pull request merge base ([8f9e769](https://github.com/HansKristoffer/expo-release/commit/8f9e7691d4c4c631c037b35c1117318ae4597b82))
* **runtime:** add getReleaseInfo, recheckOnForeground and setAndroidChannel; deliver each push response once ([8f9e769](https://github.com/HansKristoffer/expo-release/commit/8f9e7691d4c4c631c037b35c1117318ae4597b82))


### Bug Fixes

* **actions:** add runner.arch to cache keys, make the cache save non-fatal, reinstall when a kept path is missing ([8f9e769](https://github.com/HansKristoffer/expo-release/commit/8f9e7691d4c4c631c037b35c1117318ae4597b82))
* **action:** set TMPDIR to runner.temp on self-hosted runners and run Bun with the action's tsconfig ([8f9e769](https://github.com/HansKristoffer/expo-release/commit/8f9e7691d4c4c631c037b35c1117318ae4597b82))
* **cli:** fail the fingerprint with expo config's error when eas-cli fell back from a broken app config ([8f9e769](https://github.com/HansKristoffer/expo-release/commit/8f9e7691d4c4c631c037b35c1117318ae4597b82))
* **decide:** read eas build:list's project, runtimeVersion and error fields, so build_url is set and an errored build names EAS's error ([8f9e769](https://github.com/HansKristoffer/expo-release/commit/8f9e7691d4c4c631c037b35c1117318ae4597b82))
* **operate:** split update-extra-args like a shell ([8f9e769](https://github.com/HansKristoffer/expo-release/commit/8f9e7691d4c4c631c037b35c1117318ae4597b82))
* **pr-preview:** check provider access first and stop hiding failed deletes ([8f9e769](https://github.com/HansKristoffer/expo-release/commit/8f9e7691d4c4c631c037b35c1117318ae4597b82))

## [2.3.2](https://github.com/HansKristoffer/expo-release/compare/v2.3.1...v2.3.2) (2026-10-21)


### Bug Fixes

* **cli:** drop the cli.run() shims with hanzio 3.3 ([#14](https://github.com/HansKristoffer/expo-release/issues/14)) ([0bacb10](https://github.com/HansKristoffer/expo-release/commit/0bacb106d2a3b2463d4992b797aac7df4e2fe18b))

## [2.3.1](https://github.com/HansKristoffer/expo-release/compare/v2.3.0...v2.3.1) (2026-10-21)


### Bug Fixes

* **actions:** setup-workspace, pr-preview and playwright-browsers work on self-hosted runners ([#12](https://github.com/HansKristoffer/expo-release/issues/12)) ([0bbc4cd](https://github.com/HansKristoffer/expo-release/commit/0bbc4cd039d1dd4049b6fd6dd739f05dd9253853))

## [2.3.0](https://github.com/HansKristoffer/expo-release/compare/v2.2.1...v2.3.0) (2026-10-21)


### Features

* **runtime:** refresh the push token on start and rotation, add persist to usePushNotifications ([#10](https://github.com/HansKristoffer/expo-release/issues/10)) ([5bdb6a5](https://github.com/HansKristoffer/expo-release/commit/5bdb6a54491a6bfd52797be09d436135d7acf26b))

## [2.2.1](https://github.com/HansKristoffer/expo-release/compare/v2.2.0...v2.2.1) (2026-10-21)


### Miscellaneous Chores

* release 2.2.1 ([#8](https://github.com/HansKristoffer/expo-release/issues/8)) ([95cf86d](https://github.com/HansKristoffer/expo-release/commit/95cf86d56359c9bc2670fb7dcd8e933bb7119c48))

## [2.2.0](https://github.com/HansKristoffer/expo-release/compare/v2.1.1...v2.2.0) (2026-10-20)


### Features

* add app runtime helpers and reusable CI actions ([#6](https://github.com/HansKristoffer/expo-release/issues/6)) ([fab49b6](https://github.com/HansKristoffer/expo-release/commit/fab49b60fe79185006f9ea8c1bbc3adf17d214bb))


### Bug Fixes

* **run:** show exit code, stderr and stdout when a command fails ([#4](https://github.com/HansKristoffer/expo-release/issues/4)) ([d375a98](https://github.com/HansKristoffer/expo-release/commit/d375a9897c8aae03773c84a2326560bdf332ec0d))
