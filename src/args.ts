import type { CommandContext } from 'hanzio/cli'
import { z } from 'zod'

export const DEFAULT_IMPACT_PATHS = ['apps/expo/'] as const

export type ReleasePlatform = 'ios' | 'android'

export type CommandName = 'release' | 'decide' | 'operate'

export type Operation =
	| 'deploy'
	| 'force-native'
	| 'retry-ota'
	| 'republish'
	| 'rollback-embedded'

export type DeployType = 'none' | 'ota' | 'native'

export type ReleaseOptions = {
	command: CommandName
	profile: string
	base?: string
	head?: string
	platform: ReleasePlatform
	impactPaths: string[]
	ignoreExpoImpact: boolean
	operation: Operation
	deployType: DeployType
	channel: string
	environment?: string
	autoSubmit: boolean
	preUpdate?: string
	postUpdate?: string
	updateExtraArgs?: string
	exportSourceMaps: boolean
	group?: string
	runtimeVersion?: string
	message?: string
	fingerprint?: string
	dryRun: boolean
}

// Every flag falls back to an EXPO_RELEASE_* variable: the composite action passes its inputs that way.
const text = (env: string) =>
	z
		.string()
		.transform((value) => value.trim() || undefined)
		.optional()
		.meta({ env: `EXPO_RELEASE_${env}` })

// hanzio/cli skips blank env values but keeps padding (`platform: |` in YAML adds a newline).
const trimmed = <T extends z.ZodType>(schema: T) =>
	z.preprocess(
		(value) => (typeof value === 'string' ? value.trim() : value),
		schema
	)

// `--auto-submit false` takes a value, so these are not boolean switches.
const trueFalse = (env: string, fallback: 'true' | 'false') =>
	trimmed(z.enum(['true', 'false']))
		.default(fallback)
		.transform((value) => value === 'true')
		.meta({ env: `EXPO_RELEASE_${env}` })

export const releaseFlags = z
	.object({
		profile: z
			.string()
			.trim()
			.min(1)
			.meta({ env: 'EXPO_RELEASE_PROFILE' })
			.describe('EAS build profile, also the default update channel'),
		base: text('BASE')
			.meta({ env: ['EXPO_RELEASE_BASE', 'GITHUB_EVENT_BEFORE'] })
			.describe('Git base SHA for the impact diff'),
		head: text('HEAD')
			.meta({ env: ['EXPO_RELEASE_HEAD', 'GITHUB_SHA'] })
			.describe('Git head SHA for the impact diff'),
		platform: trimmed(z.enum(['ios', 'android']))
			.default('ios')
			.meta({ env: 'EXPO_RELEASE_PLATFORM' })
			.describe('Native platform'),
		impactPaths: z
			.string()
			.default(DEFAULT_IMPACT_PATHS.join(','))
			.transform((value, ctx) => {
				const paths = value
					.split(',')
					.map((path) => path.trim())
					.filter(Boolean)
				if (paths.length === 0)
					ctx.addIssue({
						code: 'custom',
						message: 'At least one --impact-paths entry is required'
					})
				return paths
			})
			.meta({ env: 'EXPO_RELEASE_IMPACT_PATHS' })
			.describe('Comma-separated repo-root paths that count as an Expo change'),
		ignoreExpoImpact: trueFalse('IGNORE_EXPO_IMPACT', 'false').describe(
			'Check the fingerprint even when no impact path changed'
		),
		operation: trimmed(
			z.enum([
				'deploy',
				'force-native',
				'retry-ota',
				'republish',
				'rollback-embedded'
			])
		)
			.default('deploy')
			.meta({ env: 'EXPO_RELEASE_OPERATION' })
			.describe('What to run'),
		deployType: trimmed(z.enum(['none', 'ota', 'native']))
			.default('none')
			.meta({ env: 'EXPO_RELEASE_DEPLOY_TYPE' })
			.describe('Decision type for operate'),
		channel: text('CHANNEL').describe(
			'EAS Update channel (default: the profile)'
		),
		environment: text('ENVIRONMENT').describe(
			'EAS environment for eas update (required for Expo SDK 55+)'
		),
		autoSubmit: trueFalse('AUTO_SUBMIT', 'true').describe(
			'Pass --auto-submit on native builds'
		),
		preUpdate: text('PRE_UPDATE').describe(
			'Shell command run before eas update'
		),
		postUpdate: text('POST_UPDATE').describe(
			'Shell command run after a successful eas update'
		),
		updateExtraArgs: text('UPDATE_EXTRA_ARGS').describe(
			'Extra tokens appended to eas update'
		),
		exportSourceMaps: trueFalse('EXPORT_SOURCE_MAPS', 'false').describe(
			'On OTA, expo export with external source maps, then publish dist'
		),
		group: text('GROUP').describe('Update group ID for --operation republish'),
		runtimeVersion: text('RUNTIME_VERSION').describe(
			'Runtime version for rollback-embedded (default: the fingerprint)'
		),
		message: text('MESSAGE').describe('Override the eas update message'),
		fingerprint: text('FINGERPRINT').describe(
			'Fingerprint hash to use instead of generating one'
		),
		dryRun: z
			.preprocess(
				// hanzio/cli makes booleans of exact `true`/`false`; this takes padded ones too.
				(value) =>
					typeof value === 'string' && /^\s*(true|false)\s*$/.test(value)
						? value.trim() === 'true'
						: value,
				z.boolean()
			)
			.meta({ env: 'EXPO_RELEASE_DRY_RUN' })
			.describe('Print mutating EAS commands without running them')
	})
	.superRefine((flags, ctx) => {
		if (flags.operation === 'republish' && !flags.group)
			ctx.addIssue({
				code: 'custom',
				path: ['group'],
				message: 'required by --operation republish'
			})
	})

export type ReleaseFlags = z.output<typeof releaseFlags>

export function toReleaseOptions(
	command: CommandName,
	{ context: flags }: CommandContext<ReleaseFlags>
): ReleaseOptions {
	return {
		...flags,
		command,
		channel: flags.channel ?? flags.profile
	}
}

export function needsDecide(operation: Operation): boolean {
	switch (operation) {
		case 'deploy':
		case 'retry-ota':
			return true
		case 'force-native':
		case 'republish':
		case 'rollback-embedded':
			return false
		default: {
			const _exhaustive: never = operation
			throw new Error(`Unsupported operation: ${_exhaustive}`)
		}
	}
}

export function shouldIgnoreExpoImpact(
	options: Pick<ReleaseOptions, 'ignoreExpoImpact' | 'operation'>
): boolean {
	if (options.ignoreExpoImpact) return true
	if (options.operation === 'retry-ota') return true
	return (
		process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
		options.operation === 'deploy'
	)
}
