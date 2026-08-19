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
			autoSubmit: true
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
