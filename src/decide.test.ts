import { describe, expect, test } from 'bun:test'
import {
	decideRelease,
	defaultBase,
	diffFingerprintSources,
	type EASBuild,
	hasExpoImpact,
	isExpoImpactPath,
	parseBuildList,
	resolveBuildDecision,
	writeDecideGitHubOutput
} from './decide'

function productionDecision(
	overrides?: Partial<Parameters<typeof decideRelease>[0]>
) {
	return {
		base: 'base',
		head: 'head',
		profile: 'production',
		platform: 'ios' as const,
		impactPaths: ['apps/expo/'],
		...overrides
	}
}

// Trimmed from `eas build:list --json` (eas-cli 16.32.0, BuildFragment).
const finishedBuild = {
	id: 'build_123',
	status: 'FINISHED',
	platform: 'IOS',
	error: null,
	fingerprint: { id: 'fp_1', hash: 'f'.repeat(64) },
	project: {
		__typename: 'App',
		id: 'project_1',
		name: 'lullu',
		slug: 'lullu',
		ownerAccount: { id: 'account_1', name: 'lullu' }
	},
	channel: 'production',
	buildProfile: 'production',
	runtimeVersion: '1.0.0'
}

describe('hasExpoImpact', () => {
	test('deploys when the Expo app changes', () => {
		expect(hasExpoImpact(['apps/expo/src/app/_layout.tsx'])).toBe(true)
		expect(hasExpoImpact(['apps/expo/package.json'])).toBe(true)
		expect(hasExpoImpact(['apps/backend/src/export-types.ts'])).toBe(false)
		expect(hasExpoImpact(['packages/utils/src/index.ts'])).toBe(false)
		expect(hasExpoImpact(['bun.lock'])).toBe(false)
	})

	test('honors custom impact paths', () => {
		const paths = ['apps/expo/', 'packages/conductor/']
		expect(hasExpoImpact(['packages/conductor/src/conductor.ts'], paths)).toBe(
			true
		)
		expect(hasExpoImpact(['packages/utils/src/index.ts'], paths)).toBe(false)
	})

	test('does not treat apps/expo-old as apps/expo', () => {
		expect(isExpoImpactPath('apps/expo-old/src/index.ts', ['apps/expo'])).toBe(
			false
		)
		expect(isExpoImpactPath('apps/expo/src/index.ts', ['apps/expo'])).toBe(true)
		expect(isExpoImpactPath('apps/expo', ['apps/expo/'])).toBe(true)
	})
})

describe('parseBuildList', () => {
	test('constructs the dashboard URL and captures fingerprint fields', () => {
		expect(parseBuildList(JSON.stringify([finishedBuild]))).toEqual([
			{
				id: 'build_123',
				status: 'finished',
				buildUrl:
					'https://expo.dev/accounts/lullu/projects/lullu/builds/build_123',
				fingerprint: 'f'.repeat(64),
				runtimeVersion: '1.0.0'
			}
		])
	})

	test('reads the older app.* and runtime.version shape too', () => {
		expect(
			parseBuildList(
				JSON.stringify([
					{
						id: 'old',
						status: 'FINISHED',
						app: { slug: 'app', ownerAccount: { name: 'me' } },
						runtime: { version: '2.0.0' }
					}
				])
			)
		).toEqual([
			{
				id: 'old',
				status: 'finished',
				buildUrl: 'https://expo.dev/accounts/me/projects/app/builds/old',
				runtimeVersion: '2.0.0'
			}
		])
	})

	test('keeps why EAS failed a build', () => {
		const [build] = parseBuildList(
			JSON.stringify([
				{
					...finishedBuild,
					status: 'ERRORED',
					error: {
						errorCode: 'EAS_BUILD_UNKNOWN_FASTLANE_ERROR',
						message: 'Fastlane failed',
						docsUrl: null
					}
				}
			])
		)
		expect(build?.error).toBe(
			'EAS_BUILD_UNKNOWN_FASTLANE_ERROR: Fastlane failed'
		)
	})

	test('skips unknown statuses instead of throwing', () => {
		const warning = process.stderr.write
		const writes: string[] = []
		process.stderr.write = ((chunk: string) => {
			writes.push(chunk)
			return true
		}) as typeof process.stderr.write
		try {
			expect(
				parseBuildList(JSON.stringify([{ id: 'x', status: 'SOMETHING_NEW' }]))
			).toEqual([])
			expect(writes.join('')).toContain('unsupported status')
		} finally {
			process.stderr.write = warning
		}
	})
})

describe('resolveBuildDecision', () => {
	test('prefers a finished matching build over active builds', () => {
		const builds: EASBuild[] = [
			{ id: 'active', status: 'in-progress' },
			{ id: 'finished', status: 'finished' }
		]
		const finished = builds[1]
		if (!finished) throw new Error('expected finished build')
		expect(resolveBuildDecision(builds)).toEqual({
			deployType: 'ota',
			reason: 'finished-build',
			nativeBuildPending: false,
			build: finished
		})
	})

	test('marks nativeBuildPending for every active EAS status', () => {
		for (const status of [
			'in-progress',
			'new',
			'in-queue',
			'pending-cancel'
		] as const) {
			expect(resolveBuildDecision([{ id: status, status }])).toEqual({
				deployType: 'ota',
				reason: 'build-in-progress',
				nativeBuildPending: true,
				build: { id: status, status }
			})
		}
	})

	test('fails when the newest build is errored', () => {
		expect(() =>
			resolveBuildDecision([
				{
					id: 'failed',
					status: 'errored',
					buildUrl:
						'https://expo.dev/accounts/lullu/projects/lullu/builds/failed'
				}
			])
		).toThrow(/force-native/)
	})

	test('an errored build names the EAS error and links the build', () => {
		expect(() =>
			resolveBuildDecision([
				{
					id: 'failed',
					status: 'errored',
					error: 'CREDENTIALS: Distribution Certificate is not validated',
					buildUrl: 'https://expo.dev/accounts/a/projects/b/builds/failed'
				}
			])
		).toThrow(
			'failed on EAS: CREDENTIALS: Distribution Certificate is not validated\nhttps://expo.dev/accounts/a/projects/b/builds/failed'
		)
	})

	test('queues a native build after a canceled build', () => {
		expect(
			resolveBuildDecision([{ id: 'canceled', status: 'canceled' }])
		).toEqual({
			deployType: 'native',
			reason: 'no-build-for-fingerprint',
			nativeBuildPending: false,
			build: null
		})
	})
})

describe('decideRelease', () => {
	test('skips fingerprint and EAS lookups when Expo did not change', async () => {
		const calls: string[][] = []
		const decision = await decideRelease(
			productionDecision(),
			async (command) => {
				calls.push(command)
				return 'apps/backend/src/export-types.ts\n'
			}
		)

		expect(decision.deployType).toBe('none')
		expect(decision.nativeBuildPending).toBe(false)
		expect(decision.fingerprint).toBeNull()
		expect(calls).toHaveLength(1)
		expect(calls[0]).toContain('diff.relative=false')
	})

	test('uses one fingerprint lookup and one unfiltered build:list', async () => {
		const calls: string[][] = []
		const fingerprint = 'f'.repeat(64)
		const responses = [
			'apps/expo/src/app/_layout.tsx\n',
			JSON.stringify({ hash: fingerprint }),
			JSON.stringify([finishedBuild])
		]
		const decision = await decideRelease(
			productionDecision(),
			async (command) => {
				calls.push(command)
				const response = responses.shift()
				if (!response) throw new Error('Unexpected command')
				return response
			}
		)

		expect(decision).toMatchObject({
			deployType: 'ota',
			nativeBuildPending: false,
			fingerprint,
			build: {
				id: 'build_123',
				buildUrl:
					'https://expo.dev/accounts/lullu/projects/lullu/builds/build_123'
			}
		})
		expect(calls[1]?.[0]).toBe('eas')
		expect(calls[1]).toContain('fingerprint:generate')
		expect(calls[2]).toContain('build:list')
		expect(calls[2]).toContain('--limit')
		expect(calls[2]).toContain('20')
		expect(calls[2]).not.toContain('--status')
		expect(calls).toHaveLength(3)
	})

	test('returns ota with nativeBuildPending when only an active build exists', async () => {
		const responses = [
			'apps/expo/src/app/_layout.tsx\n',
			JSON.stringify({ hash: 'fingerprint' }),
			JSON.stringify([{ id: 'queued', status: 'IN_QUEUE' }])
		]
		const decision = await decideRelease(productionDecision(), async () => {
			const response = responses.shift()
			if (!response) throw new Error('Unexpected command')
			return response
		})

		expect(decision).toMatchObject({
			deployType: 'ota',
			nativeBuildPending: true,
			build: { id: 'queued', status: 'in-queue' }
		})
	})

	test('returns native when no matching build exists', async () => {
		const responses = [
			'apps/expo/src/app/_layout.tsx\n',
			JSON.stringify({ hash: 'fingerprint' }),
			'[]'
		]
		const decision = await decideRelease(productionDecision(), async () => {
			const response = responses.shift()
			if (!response) throw new Error('Unexpected command')
			return response
		})

		expect(decision).toMatchObject({
			deployType: 'native',
			nativeBuildPending: false,
			fingerprint: 'fingerprint',
			build: null
		})
	})

	test('a native decision names the sources changed since the last finished build', async () => {
		const calls: string[][] = []
		const responses = [
			'apps/expo/package.json\n',
			JSON.stringify({ hash: 'new' }),
			'[]',
			JSON.stringify([finishedBuild]),
			JSON.stringify({
				fingerprint1: {
					hash: 'old',
					sources: [
						{ type: 'dir', filePath: 'node_modules/expo-camera', hash: 'a' },
						{ type: 'contents', id: 'appVersion', hash: 'v1' }
					]
				},
				fingerprint2: {
					hash: 'new',
					sources: [
						{ type: 'dir', filePath: 'node_modules/expo-camera', hash: 'b' },
						{ type: 'contents', id: 'appVersion', hash: 'v1' },
						{ type: 'file', filePath: 'app.config.ts', hash: 'c' }
					]
				}
			})
		]
		const decision = await decideRelease(
			productionDecision({ environment: 'production' }),
			async (command) => {
				calls.push(command)
				const response = responses.shift()
				if (response === undefined) throw new Error('Unexpected command')
				return response
			}
		)

		expect(decision).toMatchObject({
			deployType: 'native',
			reason: 'no-build-for-fingerprint',
			fingerprintDiff: {
				buildId: 'build_123',
				sources: ['changed node_modules/expo-camera', 'added app.config.ts']
			}
		})
		expect(calls[3]).toContain('--status')
		expect(calls[4]).toEqual([
			'eas',
			'fingerprint:compare',
			'--build-id',
			'build_123',
			'--json',
			'--non-interactive',
			'--environment',
			'production'
		])
	})

	test('a failed fingerprint comparison keeps the decision', async () => {
		const responses = ['apps/expo/package.json\n', '{"hash":"new"}', '[]']
		const decision = await decideRelease(productionDecision(), async () => {
			const response = responses.shift()
			if (response === undefined) throw new Error('eas build:list failed')
			return response
		})
		expect(decision).toMatchObject({
			deployType: 'native',
			fingerprintDiff: null
		})
	})

	test('fails when eas-cli fell back from a broken app config', async () => {
		const error = await decideRelease(productionDecision(), async (command) => {
			if (command[0] === 'git') return 'apps/expo/app.config.ts\n'
			if (command.includes('config'))
				throw new Error('stderr:\nCannot find module ./app-variants')
			return 'Failed to read the app config from the project using "npx expo config" command\nFalling back to the version of "@expo/config" shipped with the EAS CLI.\n{\n  "hash": "x"\n}'
		}).catch((e) => e)

		expect(error.stage).toBe('fingerprint')
		expect(error.message).toContain('Falling back')
		expect(error.message).toContain('Cannot find module ./app-variants')
	})

	test('runs the preflight only when EAS is needed', async () => {
		let ran = 0
		await decideRelease(
			productionDecision({ preflight: async () => void ran++ }),
			async () => 'apps/backend/x.ts\n'
		)
		expect(ran).toBe(0)
	})

	test('fails open when the git base is unreachable', async () => {
		const calls: string[][] = []
		const responses = [JSON.stringify({ hash: 'fingerprint' }), '[]']
		const decision = await decideRelease(
			productionDecision(),
			async (command) => {
				calls.push(command)
				if (command[0] === 'git') {
					throw new Error('unknown revision')
				}
				const response = responses.shift()
				if (!response) throw new Error('Unexpected command')
				return response
			}
		)

		expect(decision.deployType).toBe('native')
		expect(calls[1]).toContain('fingerprint:generate')
	})

	test('writes deploy_type for PR checks', async () => {
		const previous = process.env.GITHUB_OUTPUT
		const outputPath = `${import.meta.dir}/.github-output-${crypto.randomUUID()}`
		process.env.GITHUB_OUTPUT = outputPath
		try {
			await writeDecideGitHubOutput({
				deployType: 'ota',
				reason: 'build-in-progress',
				nativeBuildPending: true,
				changedFiles: ['apps/expo/src/app/_layout.tsx'],
				fingerprint: 'abc',
				build: { id: 'queued', status: 'in-queue' }
			})
			const output = await Bun.file(outputPath).text()
			expect(output).toContain('deploy_type<<')
			expect(output).toContain('ota')
			expect(output).toContain('native_build_pending')
		} finally {
			if (previous === undefined) {
				delete process.env.GITHUB_OUTPUT
			} else {
				process.env.GITHUB_OUTPUT = previous
			}
			await Bun.file(outputPath)
				.unlink()
				.catch(() => undefined)
		}
	})

	test('fails clearly when the EAS fingerprint output is malformed', async () => {
		await expect(
			decideRelease(productionDecision(), async (command) =>
				command[0] === 'git' ? 'apps/expo/src/app/_layout.tsx\n' : '{"hash":'
			)
		).rejects.toThrow('Expected JSON output')
	})

	test('fails clearly on output that is not JSON', async () => {
		await expect(
			decideRelease(productionDecision(), async (command) =>
				command[0] === 'git' ? 'apps/expo/src/app/_layout.tsx\n' : 'not json'
			)
		).rejects.toThrow('Expected JSON output')
	})
})

describe('diffFingerprintSources', () => {
	test('lists removed sources and caps a long list', () => {
		const many = Array.from({ length: 40 }, (_, i) => ({
			type: 'file',
			filePath: `f${i}`,
			hash: 'x'
		}))
		const lines = diffFingerprintSources({
			fingerprint1: { sources: [...many, { type: 'file', filePath: 'gone' }] },
			fingerprint2: { sources: many.map((s) => ({ ...s, hash: 'y' })) }
		})
		expect(lines).toHaveLength(31)
		expect(lines.at(-1)).toBe('... and 11 more')
	})
})

describe('defaultBase', () => {
	const keys = [
		'GITHUB_EVENT_NAME',
		'GITHUB_EVENT_PATH',
		'GITHUB_EVENT_BEFORE'
	] as const
	const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
	const restore = () => {
		for (const key of keys) {
			if (saved[key] === undefined) delete process.env[key]
			else process.env[key] = saved[key]
		}
	}

	test('uses the merge base with the base branch on a pull request', async () => {
		const path = `${import.meta.dir}/.event-${crypto.randomUUID()}.json`
		await Bun.write(
			path,
			JSON.stringify({ pull_request: { base: { sha: 'base' } } })
		)
		process.env.GITHUB_EVENT_NAME = 'pull_request'
		process.env.GITHUB_EVENT_PATH = path
		process.env.GITHUB_EVENT_BEFORE = 'previous-push'
		try {
			const calls: string[][] = []
			expect(
				await defaultBase('head', async (command) => {
					calls.push(command)
					return 'merge-base\n'
				})
			).toBe('merge-base')
			expect(calls).toEqual([['git', 'merge-base', 'base', 'head']])
		} finally {
			restore()
			await Bun.file(path).unlink()
		}
	})

	test('uses github.event.before on a push', async () => {
		process.env.GITHUB_EVENT_NAME = 'push'
		process.env.GITHUB_EVENT_BEFORE = 'before'
		try {
			expect(await defaultBase('head', async () => '')).toBe('before')
		} finally {
			restore()
		}
	})
})
