import { describe, expect, test } from 'bun:test'
import {
	operateRelease,
	parseExpoSdkMajor,
	requireEnvironmentIfNeeded,
	updateMessage
} from './operate'

const productionOperate = {
	profile: 'production',
	channel: 'production',
	environment: 'production',
	platform: 'ios' as const,
	autoSubmit: true,
	fingerprint: '9f2c1b04deadbeef'
}

describe('updateMessage', () => {
	test('includes the fingerprint prefix', () => {
		const previous = process.env.GITHUB_SHA
		process.env.GITHUB_SHA = 'abcdef1234567'
		try {
			expect(
				updateMessage({
					profile: 'production',
					fingerprint: '9f2c1b04deadbeef'
				})
			).toBe('production abcdef1 (fp 9f2c1b04)')
		} finally {
			if (previous === undefined) {
				delete process.env.GITHUB_SHA
			} else {
				process.env.GITHUB_SHA = previous
			}
		}
	})

	test('honors an explicit override', () => {
		expect(
			updateMessage({
				profile: 'production',
				fingerprint: '9f2c1b04',
				message: 'hotfix'
			})
		).toBe('hotfix')
	})
})

describe('requireEnvironmentIfNeeded', () => {
	test('parses Expo SDK majors from common ranges', () => {
		expect(parseExpoSdkMajor('~55.0.2')).toBe(55)
		expect(parseExpoSdkMajor('^54.0.0')).toBe(54)
		expect(parseExpoSdkMajor('catalog:')).toBeNull()
	})

	test('fails on SDK 55+ when environment is missing', async () => {
		await expect(
			requireEnvironmentIfNeeded({
				readPackageJson: async () => ({
					dependencies: { expo: '~55.0.0' }
				})
			})
		).rejects.toThrow('--environment')
	})

	test('allows a missing environment on older SDKs', async () => {
		await requireEnvironmentIfNeeded({
			readPackageJson: async () => ({
				dependencies: { expo: '~54.0.0' }
			})
		})
	})
})

describe('operateRelease', () => {
	test('publishes production OTA updates for a finished native match', async () => {
		const commands: string[][] = []
		const result = await operateRelease(
			{ ...productionOperate, deployType: 'ota', operation: 'deploy' },
			async (command) => {
				commands.push(command)
				return ''
			}
		)

		expect(result).toBe('ota')
		expect(commands).toHaveLength(1)
		expect(commands[0]?.[0]).toBe('eas')
		expect(commands[0]).toContain('update')
		expect(commands[0]).toContain('--channel')
		expect(commands[0]).toContain('production')
		expect(commands[0]).toContain('--platform')
		expect(commands[0]).toContain('ios')
		expect(commands[0]).toContain('--environment')
		expect(commands[0]).toContain('production manual (fp 9f2c1b04)')
	})

	test('omits --environment when it is not set', async () => {
		const commands: string[][] = []
		await operateRelease(
			{
				profile: 'production',
				deployType: 'ota',
				operation: 'deploy',
				channel: 'production',
				platform: 'ios',
				autoSubmit: true,
				readPackageJson: async () => ({ dependencies: { expo: '~54.0.0' } })
			},
			async (command) => {
				commands.push(command)
				return ''
			}
		)

		expect(commands[0]).toContain('update')
		expect(commands[0]).not.toContain('--environment')
	})

	test('publishes OTA while a matching native build is pending', async () => {
		const commands: string[][] = []
		const result = await operateRelease(
			{
				...productionOperate,
				deployType: 'ota',
				operation: 'deploy'
			},
			async (command) => {
				commands.push(command)
				return ''
			}
		)

		expect(result).toBe('ota')
		expect(commands[0]).toContain('update')
		expect(commands[0]).not.toContain('build')
	})

	test('force-native builds without publishing an OTA', async () => {
		const commands: string[][] = []
		const result = await operateRelease(
			{ ...productionOperate, deployType: 'ota', operation: 'force-native' },
			async (command) => {
				commands.push(command)
				return ''
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
				deployType: 'native',
				operation: 'deploy',
				autoSubmit: false
			},
			async (command) => {
				commands.push(command)
				return ''
			}
		)

		expect(commands[0]).toContain('build')
		expect(commands[0]).not.toContain('--auto-submit')
	})

	test('retry-ota publishes even without a matching native build decision', async () => {
		const commands: string[][] = []
		const result = await operateRelease(
			{ ...productionOperate, deployType: 'native', operation: 'retry-ota' },
			async (command) => {
				commands.push(command)
				return ''
			}
		)

		expect(result).toBe('ota')
		expect(commands[0]).toContain('update')
		expect(commands[0]).not.toContain('build')
	})

	test('republishes a specific update group', async () => {
		const commands: string[][] = []
		const result = await operateRelease(
			{
				...productionOperate,
				deployType: 'none',
				operation: 'republish',
				group: 'group-123'
			},
			async (command) => {
				commands.push(command)
				return ''
			}
		)

		expect(result).toBe('recovery')
		expect(commands[0]).toContain('update:republish')
		expect(commands[0]).toContain('--group')
		expect(commands[0]).toContain('group-123')
		expect(commands[0]).toContain('--platform')
		expect(commands[0]).not.toContain('--channel')
	})

	test('rolls back to embedded with a runtime version', async () => {
		const commands: string[][] = []
		const result = await operateRelease(
			{
				...productionOperate,
				deployType: 'none',
				operation: 'rollback-embedded',
				runtimeVersion: 'abc123'
			},
			async (command) => {
				commands.push(command)
				return ''
			}
		)

		expect(result).toBe('recovery')
		expect(commands[0]).toContain('update:roll-back-to-embedded')
		expect(commands[0]).toContain('--runtime-version')
		expect(commands[0]).toContain('abc123')
		expect(commands[0]).toContain('--platform')
	})

	test('computes a fingerprint when rollback has no runtime version', async () => {
		const commands: string[][] = []
		await operateRelease(
			{
				profile: 'production',
				channel: 'production',
				environment: 'production',
				platform: 'ios',
				autoSubmit: true,
				deployType: 'none',
				operation: 'rollback-embedded'
			},
			async (command) => {
				commands.push(command)
				if (command.includes('fingerprint:generate')) {
					return JSON.stringify({ hash: 'computed-hash' })
				}
				return ''
			}
		)

		expect(commands[0]).toContain('fingerprint:generate')
		expect(commands[1]).toContain('--runtime-version')
		expect(commands[1]).toContain('computed-hash')
	})

	test('skips deploy when the decision is none', async () => {
		const commands: string[][] = []
		const result = await operateRelease(
			{ ...productionOperate, deployType: 'none', operation: 'deploy' },
			async (command) => {
				commands.push(command)
				return ''
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
				deployType: 'ota',
				operation: 'deploy',
				preUpdate: 'bun scripts/release/export-hermes.ts',
				updateExtraArgs: '--input-dir dist --skip-bundler',
				postUpdate: 'bunx posthog-cli hermes upload --directory dist'
			},
			async (command) => {
				commands.push(command)
				return ''
			}
		)

		expect(result).toBe('ota')
		expect(commands).toEqual([
			['bash', '-c', 'bun scripts/release/export-hermes.ts'],
			expect.arrayContaining([
				'eas',
				'update',
				'--input-dir',
				'dist',
				'--skip-bundler'
			]),
			['bash', '-c', 'bunx posthog-cli hermes upload --directory dist']
		])
	})

	test('runs OTA hooks on retry-ota', async () => {
		const commands: string[][] = []
		await operateRelease(
			{
				...productionOperate,
				deployType: 'native',
				operation: 'retry-ota',
				preUpdate: 'bun scripts/release/export-hermes.ts'
			},
			async (command) => {
				commands.push(command)
				return ''
			}
		)

		expect(commands[0]).toEqual([
			'bash',
			'-c',
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
			{ deployType: 'none' as const, operation: 'deploy' as const },
			{ deployType: 'native' as const, operation: 'deploy' as const },
			{
				deployType: 'none' as const,
				operation: 'rollback-embedded' as const,
				runtimeVersion: 'abc'
			}
		]) {
			const commands: string[][] = []
			await operateRelease(
				{ ...productionOperate, ...hooks, ...input },
				async (command) => {
					commands.push(command)
					return ''
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
					deployType: 'ota',
					operation: 'deploy',
					preUpdate: 'bun scripts/release/export-hermes.ts',
					postUpdate: 'bunx posthog-cli hermes upload --directory dist'
				},
				async (command) => {
					commands.push(command)
					if (command.includes('update')) {
						throw new Error('eas update failed')
					}
					return ''
				}
			)
		).rejects.toThrow('eas update failed')
		expect(commands).toHaveLength(2)
		expect(commands[1]).toContain('update')
	})

	test('prints mutating commands during a dry run', async () => {
		const commands: string[][] = []
		const writes: string[] = []
		const warning = process.stderr.write
		process.stderr.write = ((chunk: string) => {
			writes.push(chunk)
			return true
		}) as typeof process.stderr.write
		try {
			const result = await operateRelease(
				{
					...productionOperate,
					deployType: 'ota',
					operation: 'deploy',
					dryRun: true,
					preUpdate: 'bun scripts/release/export-hermes.ts'
				},
				async (command) => {
					commands.push(command)
					return ''
				}
			)
			expect(result).toBe('ota')
			expect(commands).toHaveLength(0)
			expect(writes.join('')).toContain('[dry-run]')
			expect(writes.join('')).toContain('eas update')
		} finally {
			process.stderr.write = warning
		}
	})

	test('queues a native TestFlight build when no matching fingerprint exists', async () => {
		const commands: string[][] = []
		const result = await operateRelease(
			{ ...productionOperate, deployType: 'native', operation: 'deploy' },
			async (command) => {
				commands.push(command)
				return ''
			}
		)

		expect(result).toBe('native-build')
		expect(commands[0]).toContain('--profile')
		expect(commands[0]).toContain('production')
		expect(commands[0]).toContain('--auto-submit')
		expect(commands[0]).toContain('--no-wait')
	})
})
