import { describe, expect, test } from 'bun:test'
import { parseReleaseOptions, shouldIgnoreExpoImpact, USAGE } from './args'

describe('parseReleaseOptions', () => {
	test('defaults platform, impact paths, operation, and auto-submit', () => {
		expect(
			parseReleaseOptions(
				['decide', '--base', 'abc', '--head', 'def', '--profile', 'staging'],
				{}
			)
		).toMatchObject({
			command: 'decide',
			base: 'abc',
			head: 'def',
			profile: 'staging',
			platform: 'ios',
			impactPaths: ['apps/expo/'],
			ignoreExpoImpact: false,
			operation: 'deploy',
			deployType: 'none',
			channel: 'staging',
			autoSubmit: true,
			exportSourceMaps: false,
			dryRun: false
		})
	})

	test('parses comma-separated impact paths and operate flags', () => {
		expect(
			parseReleaseOptions(
				[
					'release',
					'--profile',
					'production',
					'--impact-paths',
					'apps/expo/,packages/conductor/',
					'--environment',
					'production',
					'--auto-submit',
					'false',
					'--export-source-maps',
					'true',
					'--dry-run'
				],
				{}
			)
		).toMatchObject({
			impactPaths: ['apps/expo/', 'packages/conductor/'],
			environment: 'production',
			autoSubmit: false,
			exportSourceMaps: true,
			dryRun: true
		})
	})

	test('reads action env vars when flags are omitted', () => {
		expect(
			parseReleaseOptions([], {
				EXPO_RELEASE_COMMAND: 'operate',
				EXPO_RELEASE_PROFILE: 'production',
				EXPO_RELEASE_OPERATION: 'republish',
				EXPO_RELEASE_GROUP: 'group-1',
				EXPO_RELEASE_PLATFORM: 'android'
			})
		).toMatchObject({
			command: 'operate',
			profile: 'production',
			operation: 'republish',
			group: 'group-1',
			platform: 'android'
		})
	})

	test('rejects unknown flags', () => {
		expect(() =>
			parseReleaseOptions(['decide', '--profil', 'production'], {})
		).toThrow(/USAGE|Unknown/)
	})

	test('requires --group for republish', () => {
		expect(() =>
			parseReleaseOptions(
				['operate', '--profile', 'production', '--operation', 'republish'],
				{}
			)
		).toThrow('--group')
	})

	test('rejects the removed republish-latest operation', () => {
		expect(() =>
			parseReleaseOptions(
				[
					'operate',
					'--profile',
					'production',
					'--operation',
					'republish-latest'
				],
				{}
			)
		).toThrow('--operation')
	})
})

describe('shouldIgnoreExpoImpact', () => {
	test('ignores impact for retry-ota', () => {
		expect(
			shouldIgnoreExpoImpact({
				ignoreExpoImpact: false,
				operation: 'retry-ota'
			})
		).toBe(true)
	})

	test('ignores impact for a dispatched deploy', () => {
		const previous = process.env.GITHUB_EVENT_NAME
		process.env.GITHUB_EVENT_NAME = 'workflow_dispatch'
		try {
			expect(
				shouldIgnoreExpoImpact({
					ignoreExpoImpact: false,
					operation: 'deploy'
				})
			).toBe(true)
		} finally {
			if (previous === undefined) {
				delete process.env.GITHUB_EVENT_NAME
			} else {
				process.env.GITHUB_EVENT_NAME = previous
			}
		}
	})
})

describe('USAGE', () => {
	test('documents the public commands', () => {
		expect(USAGE).toContain('expo-release <release|decide|operate>')
		expect(USAGE).toContain('--export-source-maps')
	})
})
