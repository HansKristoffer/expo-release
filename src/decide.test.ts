import { describe, expect, test } from 'bun:test'
import {
	decideRelease,
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

const finishedBuild = {
	id: 'build_123',
	status: 'FINISHED',
	app: {
		slug: 'lullu',
		ownerAccount: { name: 'lullu' }
	},
	fingerprint: { hash: 'f'.repeat(64) },
	runtime: { version: '1.0.0' }
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

	test('queues a native build after a canceled build', () => {
		expect(
			resolveBuildDecision([{ id: 'canceled', status: 'canceled' }])
		).toEqual({
			deployType: 'native',
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
				command[0] === 'git' ? 'apps/expo/src/app/_layout.tsx\n' : 'not json'
			)
		).rejects.toThrow('Expected JSON output')
	})
})
