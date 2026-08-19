import { describe, expect, test } from 'bun:test'
import {
	decideRelease,
	type EASBuild,
	hasExpoImpact,
	parseDecideArgs,
	resolveBuildAction
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
})

describe('parseDecideArgs', () => {
	test('defaults platform and impact paths', () => {
		expect(
			parseDecideArgs([
				'--base',
				'abc',
				'--head',
				'def',
				'--profile',
				'staging'
			])
		).toEqual({
			base: 'abc',
			head: 'def',
			profile: 'staging',
			platform: 'ios',
			impactPaths: ['apps/expo/'],
			ignoreExpoImpact: false
		})
	})

	test('parses comma-separated impact paths', () => {
		expect(
			parseDecideArgs([
				'--base',
				'abc',
				'--head',
				'def',
				'--profile',
				'production',
				'--impact-paths',
				'apps/expo/,packages/conductor/'
			]).impactPaths
		).toEqual(['apps/expo/', 'packages/conductor/'])
	})
})

describe('resolveBuildAction', () => {
	test('prefers a finished matching build over active builds', () => {
		const builds: EASBuild[] = [
			{ id: 'active', status: 'in-progress' },
			{ id: 'finished', status: 'finished' }
		]
		const finished = builds[1]
		if (!finished) throw new Error('expected finished build')
		expect(resolveBuildAction(builds)).toEqual({
			action: 'ota',
			build: finished
		})
	})

	test('waits for all active EAS statuses without duplicating a build', () => {
		for (const status of [
			'in-progress',
			'new',
			'in-queue',
			'pending-cancel'
		] as const) {
			expect(resolveBuildAction([{ id: status, status }])).toEqual({
				action: 'build-in-progress',
				build: { id: status, status }
			})
		}
	})

	test('retries after terminal build failures', () => {
		expect(resolveBuildAction([{ id: 'failed', status: 'errored' }])).toEqual({
			action: 'build',
			build: null
		})
		expect(
			resolveBuildAction([{ id: 'canceled', status: 'canceled' }])
		).toEqual({
			action: 'build',
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

		expect(decision.action).toBe('skip')
		expect(decision.fingerprint).toBeNull()
		expect(calls).toHaveLength(1)
	})

	test('uses EAS fingerprints and a targeted finished lookup', async () => {
		const calls: string[][] = []
		const fingerprint = 'f'.repeat(64)
		const responses = [
			'apps/expo/src/app/_layout.tsx\n',
			JSON.stringify({ hash: fingerprint }),
			JSON.stringify([
				{
					id: 'build_123',
					status: 'FINISHED',
					buildDetailsPageUrl: 'https://expo.dev/builds/build_123'
				}
			])
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
			action: 'ota',
			fingerprint,
			build: {
				id: 'build_123',
				buildUrl: 'https://expo.dev/builds/build_123'
			}
		})
		expect(calls[1]).toContain('eas')
		expect(calls[1]).toContain('fingerprint:generate')
		expect(calls[1]).toContain('--build-profile')
		expect(calls[1]).toContain('production')
		expect(calls[2]).toContain('--status')
		expect(calls[2]).toContain('finished')
		expect(calls[2]).toContain('--limit')
		expect(calls[2]).toContain('1')
	})

	test('checks active build statuses after no finished build is found', async () => {
		const responses = [
			'apps/expo/src/app/_layout.tsx\n',
			JSON.stringify({ hash: 'fingerprint' }),
			'[]',
			'[]',
			'[]',
			JSON.stringify([{ id: 'queued', status: 'IN_QUEUE' }])
		]
		const decision = await decideRelease(productionDecision(), async () => {
			const response = responses.shift()
			if (!response) throw new Error('Unexpected command')
			return response
		})

		expect(decision).toMatchObject({
			action: 'build-in-progress',
			build: { id: 'queued', status: 'in-queue' }
		})
	})

	test('fails clearly when the EAS fingerprint output is malformed', async () => {
		await expect(
			decideRelease(productionDecision(), async (command) =>
				command[0] === 'git' ? 'apps/expo/src/app/_layout.tsx\n' : 'not json'
			)
		).rejects.toThrow('Expected JSON output')
	})
})
