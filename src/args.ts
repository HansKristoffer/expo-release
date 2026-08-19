import { parseArgs } from 'node:util'

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

export const USAGE =
	'Usage: expo-release <release|decide|operate> --profile <profile> [--base <sha>] [--head <sha>] [--platform ios|android] [--impact-paths apps/expo/] [--operation deploy|force-native|retry-ota|republish|rollback-embedded] [--deploy-type none|ota|native] [--channel <channel>] [--environment <env>] [--group <id>] [--runtime-version <hash>] [--message <msg>] [--fingerprint <hash>] [--auto-submit true] [--export-source-maps true] [--pre-update <cmd>] [--post-update <cmd>] [--update-extra-args <args>] [--dry-run] [--ignore-expo-impact true]'

function fromEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const value = env[name]?.trim()
	return value ? value : undefined
}

function firstDefined(
	...values: Array<string | undefined>
): string | undefined {
	return values.find((value) => value !== undefined && value.length > 0)
}

export function optionalString(value: string | undefined): string | undefined {
	const trimmed = value?.trim()
	return trimmed ? trimmed : undefined
}

export function parseImpactPaths(value: string | undefined): string[] {
	const paths = (value ?? DEFAULT_IMPACT_PATHS.join(','))
		.split(',')
		.map((path) => path.trim())
		.filter(Boolean)
	if (paths.length === 0) {
		throw new Error('At least one --impact-paths entry is required')
	}
	return paths
}

export function parsePlatform(value: string | undefined): ReleasePlatform {
	if (value === undefined || value === 'ios') return 'ios'
	if (value === 'android') return 'android'
	throw new Error('Usage: --platform ios|android')
}

export function parseBoolean(value: string | undefined, fallback: boolean) {
	if (value === undefined) return fallback
	if (value === 'true') return true
	if (value === 'false') return false
	throw new Error(`Expected true or false, received: ${value}`)
}

export function parseOperation(value: string | undefined): Operation {
	if (
		value === undefined ||
		value === 'deploy' ||
		value === 'force-native' ||
		value === 'retry-ota' ||
		value === 'republish' ||
		value === 'rollback-embedded'
	) {
		return value ?? 'deploy'
	}
	throw new Error(
		'Usage: --operation deploy|force-native|retry-ota|republish|rollback-embedded'
	)
}

export function parseDeployType(value: string | undefined): DeployType {
	if (value === undefined || value === 'none') return 'none'
	if (value === 'ota' || value === 'native') return value
	throw new Error('Usage: --deploy-type none|ota|native')
}

export function parseCommandName(value: string | undefined): CommandName {
	if (value === 'release' || value === 'decide' || value === 'operate') {
		return value
	}
	throw new Error(USAGE)
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

export function parseReleaseOptions(
	args: string[],
	env: NodeJS.ProcessEnv = process.env
): ReleaseOptions {
	let values: {
		profile?: string
		base?: string
		head?: string
		platform?: string
		'impact-paths'?: string
		'ignore-expo-impact'?: string
		operation?: string
		'deploy-type'?: string
		channel?: string
		environment?: string
		'auto-submit'?: string
		'pre-update'?: string
		'post-update'?: string
		'update-extra-args'?: string
		'export-source-maps'?: string
		group?: string
		'runtime-version'?: string
		message?: string
		fingerprint?: string
		'dry-run'?: boolean
	}
	let positionals: string[]

	try {
		const parsed = parseArgs({
			args,
			allowPositionals: true,
			strict: true,
			options: {
				profile: { type: 'string' },
				base: { type: 'string' },
				head: { type: 'string' },
				platform: { type: 'string' },
				'impact-paths': { type: 'string' },
				'ignore-expo-impact': { type: 'string' },
				operation: { type: 'string' },
				'deploy-type': { type: 'string' },
				channel: { type: 'string' },
				environment: { type: 'string' },
				'auto-submit': { type: 'string' },
				'pre-update': { type: 'string' },
				'post-update': { type: 'string' },
				'update-extra-args': { type: 'string' },
				'export-source-maps': { type: 'string' },
				group: { type: 'string' },
				'runtime-version': { type: 'string' },
				message: { type: 'string' },
				fingerprint: { type: 'string' },
				'dry-run': { type: 'boolean', default: false }
			}
		})
		values = parsed.values
		positionals = parsed.positionals
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(`${USAGE}\n${message}`)
	}

	if (positionals.length > 1) {
		throw new Error(USAGE)
	}

	const command = parseCommandName(
		positionals[0] ?? fromEnv(env, 'EXPO_RELEASE_COMMAND')
	)
	const profile = firstDefined(
		values.profile,
		fromEnv(env, 'EXPO_RELEASE_PROFILE')
	)
	if (!profile) {
		throw new Error(USAGE)
	}

	const operation = parseOperation(
		firstDefined(values.operation, fromEnv(env, 'EXPO_RELEASE_OPERATION'))
	)
	const group = optionalString(
		firstDefined(values.group, fromEnv(env, 'EXPO_RELEASE_GROUP'))
	)
	if (operation === 'republish' && !group) {
		throw new Error(
			'Usage: --operation republish requires --group <update-group-id>'
		)
	}

	const channel =
		firstDefined(values.channel, fromEnv(env, 'EXPO_RELEASE_CHANNEL')) ??
		profile

	return {
		command,
		profile,
		base: optionalString(
			firstDefined(
				values.base,
				fromEnv(env, 'EXPO_RELEASE_BASE'),
				fromEnv(env, 'GITHUB_EVENT_BEFORE')
			)
		),
		head: optionalString(
			firstDefined(
				values.head,
				fromEnv(env, 'EXPO_RELEASE_HEAD'),
				fromEnv(env, 'GITHUB_SHA')
			)
		),
		platform: parsePlatform(
			firstDefined(values.platform, fromEnv(env, 'EXPO_RELEASE_PLATFORM'))
		),
		impactPaths: parseImpactPaths(
			firstDefined(
				values['impact-paths'],
				fromEnv(env, 'EXPO_RELEASE_IMPACT_PATHS')
			)
		),
		ignoreExpoImpact: parseBoolean(
			firstDefined(
				values['ignore-expo-impact'],
				fromEnv(env, 'EXPO_RELEASE_IGNORE_EXPO_IMPACT')
			),
			false
		),
		operation,
		deployType: parseDeployType(
			firstDefined(
				values['deploy-type'],
				fromEnv(env, 'EXPO_RELEASE_DEPLOY_TYPE')
			)
		),
		channel,
		environment: optionalString(
			firstDefined(values.environment, fromEnv(env, 'EXPO_RELEASE_ENVIRONMENT'))
		),
		autoSubmit: parseBoolean(
			firstDefined(
				values['auto-submit'],
				fromEnv(env, 'EXPO_RELEASE_AUTO_SUBMIT')
			),
			true
		),
		preUpdate: optionalString(
			firstDefined(
				values['pre-update'],
				fromEnv(env, 'EXPO_RELEASE_PRE_UPDATE')
			)
		),
		postUpdate: optionalString(
			firstDefined(
				values['post-update'],
				fromEnv(env, 'EXPO_RELEASE_POST_UPDATE')
			)
		),
		updateExtraArgs: optionalString(
			firstDefined(
				values['update-extra-args'],
				fromEnv(env, 'EXPO_RELEASE_UPDATE_EXTRA_ARGS')
			)
		),
		exportSourceMaps: parseBoolean(
			firstDefined(
				values['export-source-maps'],
				fromEnv(env, 'EXPO_RELEASE_EXPORT_SOURCE_MAPS')
			),
			false
		),
		group,
		runtimeVersion: optionalString(
			firstDefined(
				values['runtime-version'],
				fromEnv(env, 'EXPO_RELEASE_RUNTIME_VERSION')
			)
		),
		message: optionalString(
			firstDefined(values.message, fromEnv(env, 'EXPO_RELEASE_MESSAGE'))
		),
		fingerprint: optionalString(
			firstDefined(values.fingerprint, fromEnv(env, 'EXPO_RELEASE_FINGERPRINT'))
		),
		dryRun:
			values['dry-run'] === true ||
			parseBoolean(fromEnv(env, 'EXPO_RELEASE_DRY_RUN'), false)
	}
}
