import type { DeployType, Operation, ReleasePlatform } from './args'
import { appendGitHubOutput } from './github-output'
import {
	type CommandRunner,
	dryRunCommand,
	easCommand,
	generateFingerprint,
	runInherited
} from './run'

export type { Operation }

export type OperationInput = {
	profile: string
	deployType: DeployType
	operation: Operation
	channel: string
	environment?: string
	platform: ReleasePlatform
	autoSubmit: boolean
	fingerprint?: string
	group?: string
	runtimeVersion?: string
	message?: string
	preUpdate?: string
	postUpdate?: string
	updateExtraArgs?: string
	dryRun?: boolean
	readPackageJson?: () => Promise<unknown>
}

export type OperationResult = 'skipped' | 'ota' | 'native-build' | 'recovery'

function extraUpdateArgs(value: string | undefined): string[] {
	return value?.split(/\s+/).filter(Boolean) ?? []
}

export function updateMessage(input: {
	profile: string
	fingerprint?: string
	message?: string
}): string {
	if (input.message) return input.message
	const sha = process.env.GITHUB_SHA?.slice(0, 7) ?? 'manual'
	const fingerprint = input.fingerprint?.slice(0, 8)
	if (fingerprint) {
		return `${input.profile} ${sha} (fp ${fingerprint})`
	}
	return `${input.profile} ${sha}`
}

export function parseExpoSdkMajor(version: string | undefined): number | null {
	if (!version) return null
	const match = version.match(/(\d+)/)
	if (!match?.[1]) return null
	return Number(match[1])
}

async function defaultReadPackageJson(): Promise<unknown> {
	const file = Bun.file('package.json')
	if (!(await file.exists())) return null
	return file.json()
}

export async function requireEnvironmentIfNeeded(
	input: Pick<OperationInput, 'environment' | 'readPackageJson'>
) {
	if (input.environment) return
	const pkg = await (input.readPackageJson ?? defaultReadPackageJson)()
	if (!pkg || typeof pkg !== 'object' || pkg === null) return
	const record = pkg as {
		dependencies?: { expo?: string }
		devDependencies?: { expo?: string }
	}
	const version = record.dependencies?.expo ?? record.devDependencies?.expo
	const major = parseExpoSdkMajor(version)
	if (major !== null && major >= 55) {
		throw new Error(
			'EAS Update requires --environment for Expo SDK 55+. Pass --environment <name>.'
		)
	}
}

async function runHook(
	command: string | undefined,
	commandRunner: CommandRunner
) {
	if (!command) return
	await commandRunner(['bash', '-c', command])
}

function mutatingRunner(
	commandRunner: CommandRunner,
	dryRun: boolean
): CommandRunner {
	return async (command) => {
		if (dryRun) {
			dryRunCommand(command)
			return ''
		}
		return commandRunner(command)
	}
}

async function publishUpdate(
	input: OperationInput,
	commandRunner: CommandRunner
) {
	await requireEnvironmentIfNeeded(input)
	await runHook(input.preUpdate, commandRunner)
	const command = easCommand(
		'update',
		'--channel',
		input.channel,
		'--platform',
		input.platform,
		'--message',
		updateMessage(input),
		'--non-interactive'
	)
	if (input.environment) {
		command.push('--environment', input.environment)
	}
	command.push(...extraUpdateArgs(input.updateExtraArgs))
	await commandRunner(command)
	await runHook(input.postUpdate, commandRunner)
}

async function queueNativeBuild(
	input: OperationInput,
	commandRunner: CommandRunner
) {
	const command = easCommand(
		'build',
		'--platform',
		input.platform,
		'--profile',
		input.profile,
		'--non-interactive',
		'--no-wait'
	)
	if (input.autoSubmit) {
		command.push('--auto-submit')
	}
	await commandRunner(command)
}

async function resolveRuntimeVersion(
	input: OperationInput,
	commandRunner: CommandRunner
): Promise<string> {
	if (input.runtimeVersion) return input.runtimeVersion
	if (input.fingerprint) return input.fingerprint
	return generateFingerprint(input, commandRunner)
}

export async function operateRelease(
	input: OperationInput,
	commandRunner: CommandRunner = runInherited
): Promise<OperationResult> {
	const execute = mutatingRunner(commandRunner, input.dryRun === true)

	switch (input.operation) {
		case 'republish': {
			if (!input.group) {
				throw new Error(
					'Usage: --operation republish requires --group <update-group-id>'
				)
			}
			await requireEnvironmentIfNeeded(input)
			await execute(
				easCommand(
					'update:republish',
					'--group',
					input.group,
					'--platform',
					input.platform,
					'--message',
					updateMessage(input),
					'--non-interactive'
				)
			)
			return 'recovery'
		}
		case 'rollback-embedded': {
			await requireEnvironmentIfNeeded(input)
			const runtimeVersion = await resolveRuntimeVersion(input, commandRunner)
			await execute(
				easCommand(
					'update:roll-back-to-embedded',
					'--channel',
					input.channel,
					'--platform',
					input.platform,
					'--runtime-version',
					runtimeVersion,
					'--message',
					updateMessage(input),
					'--non-interactive'
				)
			)
			return 'recovery'
		}
		case 'force-native':
			await queueNativeBuild(input, execute)
			return 'native-build'
		case 'retry-ota':
			await publishUpdate(input, execute)
			return 'ota'
		case 'deploy':
			break
		default: {
			const _exhaustive: never = input.operation
			throw new Error(`Unsupported operation: ${_exhaustive}`)
		}
	}

	switch (input.deployType) {
		case 'none':
			return 'skipped'
		case 'native':
			await queueNativeBuild(input, execute)
			return 'native-build'
		case 'ota':
			await publishUpdate(input, execute)
			return 'ota'
		default: {
			const _exhaustive: never = input.deployType
			throw new Error(`Unsupported deploy type: ${_exhaustive}`)
		}
	}
}

export async function writeOperateGitHubOutput(result: OperationResult) {
	await appendGitHubOutput({ result })
}
