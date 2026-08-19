import { describe, expect, test } from 'bun:test'
import { operateRelease, parseOperateArgs } from './operate'

const productionOperate = {
	profile: 'production',
	channel: 'production',
	environment: 'production',
	platform: 'ios' as const,
	autoSubmit: true
}

describe('parseOperateArgs', () => {
	test('defaults channel to profile and auto-submit to true', () => {
		expect(
			parseOperateArgs([
				'--profile',
				'staging',
				'--action',
				'ota',
				'--operation',
				'deploy'
			])
		).toEqual({
			profile: 'staging',
			action: 'ota',
			operation: 'deploy',
			channel: 'staging',
			environment: undefined,
			platform: 'ios',
			autoSubmit: true,
			preUpdate: undefined,
			postUpdate: undefined,
			updateExtraArgs: undefined
		})
	})

	test('parses OTA hook commands and extra update args', () => {
		expect(
			parseOperateArgs([
				'--profile',
				'production',
				'--action',
				'ota',
				'--operation',
				'deploy',
				'--pre-update',
				'bun scripts/release/export-hermes.ts',
				'--update-extra-args',
				'--input-dir dist --skip-bundler',
				'--post-update',
				'bunx posthog-cli hermes upload --directory dist'
			])
		).toMatchObject({
			preUpdate: 'bun scripts/release/export-hermes.ts',
			updateExtraArgs: '--input-dir dist --skip-bundler',
			postUpdate: 'bunx posthog-cli hermes upload --directory dist'
		})
	})

	test('accepts an optional environment and disabled auto-submit', () => {
		expect(
			parseOperateArgs([
				'--profile',
				'production',
				'--action',
				'build',
				'--operation',
				'deploy',
				'--environment',
				'production',
				'--auto-submit',
				'false'
			])
		).toMatchObject({
			environment: 'production',
			autoSubmit: false
		})
	})
})

describe('operateRelease', () => {
	test('publishes production OTA updates for a finished native match', async () => {
		const commands: string[][] = []
		const result = await operateRelease(
			{ ...productionOperate, action: 'ota', operation: 'deploy' },
			async (command) => {
				commands.push(command)
			}
		)

		expect(result).toBe('ota')
		expect(commands).toHaveLength(1)
		expect(commands[0]).toContain('eas')
		expect(commands[0]).toContain('update')
		expect(commands[0]).toContain('--channel')
		expect(commands[0]).toContain('production')
		expect(commands[0]).toContain('--environment')
	})

	test('omits --environment when it is not set', async () => {
		const commands: string[][] = []
		await operateRelease(
			{
				profile: 'production',
				action: 'ota',
				operation: 'deploy',
				channel: 'production',
				platform: 'ios',
				autoSubmit: true
			},
			async (command) => {
				commands.push(command)
			}
		)

		expect(commands[0]).toContain('update')
		expect(commands[0]).not.toContain('--environment')
	})

	test('publishes OTA while a matching native build is active', async () => {
		const commands: string[][] = []
		const result = await operateRelease(
			{
				...productionOperate,
				action: 'build-in-progress',
				operation: 'deploy'
			},
			async (command) => {
				commands.push(command)
			}
		)

		expect(result).toBe('ota')
		expect(commands[0]).toContain('update')
		expect(commands[0]).not.toContain('build')
	})

	test('force-native builds without publishing an OTA', async () => {
		const commands: string[][] = []
		const result = await operateRelease(
			{ ...productionOperate, action: 'ota', operation: 'force-native' },
			async (command) => {
				commands.push(command)
			}
		)

		expect(result).toBe('native-build')
		expect(commands).toHaveLength(1)
		expect(commands[0]).toContain('build')
		expect(commands[0]).toContain('--auto-submit')
		expect(commands[0]).not.toContain('update')
	})

	test('skips auto-submit when disabled', async () => {
		const commands: string[][] = []
		await operateRelease(
			{
				...productionOperate,
				action: 'build',
				operation: 'deploy',
				autoSubmit: false
			},
			async (command) => {
				commands.push(command)
			}
		)

		expect(commands[0]).toContain('build')
		expect(commands[0]).not.toContain('--auto-submit')
	})

	test('retry-ota publishes even without a matching native build decision', async () => {
		const commands: string[][] = []
		const result = await operateRelease(
			{ ...productionOperate, action: 'build', operation: 'retry-ota' },
			async (command) => {
				commands.push(command)
			}
		)

		expect(result).toBe('ota')
		expect(commands[0]).toContain('update')
		expect(commands[0]).not.toContain('build')
	})

	test('runs recovery independently of a decision action', async () => {
		const commands: string[][] = []
		const result = await operateRelease(
			{
				...productionOperate,
				action: 'skip',
				operation: 'rollback-embedded'
			},
			async (command) => {
				commands.push(command)
			}
		)

		expect(result).toBe('recovery')
		expect(commands[0]).toContain('update:roll-back-to-embedded')
	})

	test('skips deploy when the decision is skip', async () => {
		const commands: string[][] = []
		const result = await operateRelease(
			{ ...productionOperate, action: 'skip', operation: 'deploy' },
			async (command) => {
				commands.push(command)
			}
		)

		expect(result).toBe('skipped')
		expect(commands).toHaveLength(0)
	})

	test('runs pre-update, extra args, and post-update around eas update', async () => {
		const commands: string[][] = []
		const result = await operateRelease(
			{
				...productionOperate,
				action: 'ota',
				operation: 'deploy',
				preUpdate: 'bun scripts/release/export-hermes.ts',
				updateExtraArgs: '--input-dir dist --skip-bundler',
				postUpdate: 'bunx posthog-cli hermes upload --directory dist'
			},
			async (command) => {
				commands.push(command)
			}
		)

		expect(result).toBe('ota')
		expect(commands).toEqual([
			['bash', '-lc', 'bun scripts/release/export-hermes.ts'],
			expect.arrayContaining([
				'eas',
				'update',
				'--input-dir',
				'dist',
				'--skip-bundler'
			]),
			['bash', '-lc', 'bunx posthog-cli hermes upload --directory dist']
		])
	})

	test('runs OTA hooks on retry-ota', async () => {
		const commands: string[][] = []
		await operateRelease(
			{
				...productionOperate,
				action: 'build',
				operation: 'retry-ota',
				preUpdate: 'bun scripts/release/export-hermes.ts'
			},
			async (command) => {
				commands.push(command)
			}
		)

		expect(commands[0]).toEqual([
			'bash',
			'-lc',
			'bun scripts/release/export-hermes.ts'
		])
		expect(commands[1]).toContain('update')
	})

	test('does not run OTA hooks for skip, native build, or recovery', async () => {
		const hooks = {
			preUpdate: 'bun scripts/release/export-hermes.ts',
			postUpdate: 'bunx posthog-cli hermes upload --directory dist',
			updateExtraArgs: '--skip-bundler'
		}

		for (const input of [
			{ action: 'skip' as const, operation: 'deploy' as const },
			{ action: 'build' as const, operation: 'deploy' as const },
			{ action: 'skip' as const, operation: 'rollback-embedded' as const }
		]) {
			const commands: string[][] = []
			await operateRelease(
				{ ...productionOperate, ...hooks, ...input },
				async (command) => {
					commands.push(command)
				}
			)
			expect(commands.some((command) => command[0] === 'bash')).toBe(false)
			expect(commands.flat()).not.toContain('--skip-bundler')
		}
	})

	test('skips post-update when eas update fails', async () => {
		const commands: string[][] = []
		await expect(
			operateRelease(
				{
					...productionOperate,
					action: 'ota',
					operation: 'deploy',
					preUpdate: 'bun scripts/release/export-hermes.ts',
					postUpdate: 'bunx posthog-cli hermes upload --directory dist'
				},
				async (command) => {
					commands.push(command)
					if (command.includes('update')) {
						throw new Error('eas update failed')
					}
				}
			)
		).rejects.toThrow('eas update failed')
		expect(commands).toHaveLength(2)
		expect(commands[1]).toContain('update')
	})

	test('queues a native TestFlight build when no matching fingerprint exists', async () => {
		const commands: string[][] = []
		const result = await operateRelease(
			{ ...productionOperate, action: 'build', operation: 'deploy' },
			async (command) => {
				commands.push(command)
			}
		)

		expect(result).toBe('native-build')
		expect(commands[0]).toContain('--profile')
		expect(commands[0]).toContain('production')
		expect(commands[0]).toContain('--auto-submit')
		expect(commands[0]).toContain('--no-wait')
	})
})
