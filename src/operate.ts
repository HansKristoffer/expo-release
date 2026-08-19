import {
	parseBoolean,
	parseFlagArgs,
	parsePlatform,
	type ReleasePlatform
} from './args'
import type { ReleaseAction } from './decide'
import { appendGitHubOutput } from './github-output'

export type Operation =
	| 'deploy'
	| 'force-native'
	| 'retry-ota'
	| 'republish-latest'
	| 'rollback-embedded'

export type OperationInput = {
	profile: string
	action: ReleaseAction
	operation: Operation
	channel: string
	environment?: string
	platform: ReleasePlatform
	autoSubmit: boolean
	preUpdate?: string
	postUpdate?: string
	updateExtraArgs?: string
}

type CommandRunner = (command: string[]) => Promise<void>

const OPERATE_USAGE =
	'Usage: expo-release operate --profile <profile> --action <action> --operation <operation> [--channel <channel>] [--environment <env>] [--platform ios] [--auto-submit true] [--pre-update <cmd>] [--post-update <cmd>] [--update-extra-args <args>]'

async function run(command: string[]): Promise<void> {
	const child = Bun.spawn(command, { stdout: 'inherit', stderr: 'inherit' })
	const exitCode = await child.exited
	if (exitCode !== 0) {
		throw new Error(`Command failed (${command.join(' ')})`)
	}
}

function messageFor(profile: string): string {
	const sha = process.env.GITHUB_SHA?.slice(0, 7) ?? 'manual'
	return `${profile} ${sha}`
}

async function runHook(
	command: string | undefined,
	commandRunner: CommandRunner
) {
	if (!command) return
	await commandRunner(['bash', '-lc', command])
}

function extraUpdateArgs(value: string | undefined): string[] {
	return value?.split(/\s+/).filter(Boolean) ?? []
}

async function publishUpdate(
	input: OperationInput,
	commandRunner: CommandRunner
) {
	await runHook(input.preUpdate, commandRunner)
	const command = ['bunx', 'eas', 'update', '--channel', input.channel]
	if (input.environment) {
		command.push('--environment', input.environment)
	}
	command.push('--message', messageFor(input.profile), '--non-interactive')
	command.push(...extraUpdateArgs(input.updateExtraArgs))
	await commandRunner(command)
	await runHook(input.postUpdate, commandRunner)
}

async function queueNativeBuild(
	input: OperationInput,
	commandRunner: CommandRunner
) {
	const command = [
		'bunx',
		'eas',
		'build',
		'--platform',
		input.platform,
		'--profile',
		input.profile,
		'--non-interactive',
		'--no-wait'
	]
	if (input.autoSubmit) {
		command.push('--auto-submit')
	}
	await commandRunner(command)
}

export type OperationResult = 'skipped' | 'ota' | 'native-build' | 'recovery'

export async function operateRelease(
	input: OperationInput,
	commandRunner: CommandRunner = run
): Promise<OperationResult> {
	switch (input.operation) {
		case 'republish-latest':
			await commandRunner([
				'bunx',
				'eas',
				'update:republish',
				'--channel',
				input.channel,
				'--message',
				`Recovery republish ${messageFor(input.profile)}`,
				'--non-interactive'
			])
			return 'recovery'
		case 'rollback-embedded':
			await commandRunner([
				'bunx',
				'eas',
				'update:roll-back-to-embedded',
				'--channel',
				input.channel,
				'--message',
				`Recovery rollback ${messageFor(input.profile)}`,
				'--non-interactive'
			])
			return 'recovery'
		case 'force-native':
			await queueNativeBuild(input, commandRunner)
			return 'native-build'
		case 'retry-ota':
			await publishUpdate(input, commandRunner)
			return 'ota'
		case 'deploy':
			break
		default: {
			const _exhaustive: never = input.operation
			throw new Error(`Unsupported operation: ${_exhaustive}`)
		}
	}

	switch (input.action) {
		case 'skip':
			return 'skipped'
		case 'build':
			await queueNativeBuild(input, commandRunner)
			return 'native-build'
		case 'ota':
		case 'build-in-progress':
			await publishUpdate(input, commandRunner)
			return 'ota'
		default: {
			const _exhaustive: never = input.action
			throw new Error(`Unsupported action: ${_exhaustive}`)
		}
	}
}

function parseAction(value: string | undefined): ReleaseAction {
	if (
		value === 'skip' ||
		value === 'ota' ||
		value === 'build' ||
		value === 'build-in-progress'
	) {
		return value
	}
	throw new Error(OPERATE_USAGE)
}

function optionalString(value: string | undefined): string | undefined {
	const trimmed = value?.trim()
	return trimmed ? trimmed : undefined
}

function parseOperation(value: string | undefined): Operation {
	if (
		value === 'deploy' ||
		value === 'force-native' ||
		value === 'retry-ota' ||
		value === 'republish-latest' ||
		value === 'rollback-embedded'
	) {
		return value
	}
	throw new Error(OPERATE_USAGE)
}

export function parseOperateArgs(args: string[]): OperationInput {
	const values = parseFlagArgs(args, OPERATE_USAGE)
	const profile = values.get('profile')
	if (!profile) {
		throw new Error(OPERATE_USAGE)
	}

	return {
		profile,
		action: parseAction(values.get('action')),
		operation: parseOperation(values.get('operation')),
		channel: values.get('channel') ?? profile,
		environment: values.get('environment'),
		platform: parsePlatform(values.get('platform')),
		autoSubmit: parseBoolean(values.get('auto-submit'), true),
		preUpdate: optionalString(values.get('pre-update')),
		postUpdate: optionalString(values.get('post-update')),
		updateExtraArgs: optionalString(values.get('update-extra-args'))
	}
}

export async function writeOperateGitHubOutput(result: OperationResult) {
	await appendGitHubOutput([`result=${result}`])
}
