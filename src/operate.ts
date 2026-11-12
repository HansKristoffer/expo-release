import type { DeployType, Operation, ReleasePlatform } from './args'
import { type EASBuild, parseBuildList } from './decide'
import { appendGitHubOutput } from './github-output'
import {
	type CommandRunner,
	dryRunCommand,
	easCommand,
	generateFingerprint,
	runInherited,
	stage
} from './run'
import {
	assertSourceMaps,
	mergeUpdateArgs,
	sourceMapExportCommand
} from './source-maps'

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
	exportSourceMaps?: boolean
	dryRun?: boolean
	/** Called with the native build `eas build` queued, when it printed one. */
	onQueuedBuild?: (build: EASBuild) => void
	readPackageJson?: () => Promise<unknown>
	hasSourceMaps?: () => Promise<boolean>
}

export type OperationResult = 'skipped' | 'ota' | 'native-build' | 'recovery'

/** Splits like a shell: whitespace separates, single or double quotes group. */
export function splitArgs(value: string | undefined): string[] {
	const args: string[] = []
	for (const match of (value ?? '').matchAll(
		/"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g
	)) {
		args.push(match[1]?.replace(/\\(.)/g, '$1') ?? match[2] ?? match[3] ?? '')
	}
	return args
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

/** The Expo SDK major from package.json, or null when it is not a version. */
export async function readExpoSdkMajor(
	readPackageJson: () => Promise<unknown> = defaultReadPackageJson
): Promise<number | null> {
	const pkg = await readPackageJson()
	if (!pkg || typeof pkg !== 'object') return null
	const record = pkg as {
		dependencies?: { expo?: string }
		devDependencies?: { expo?: string }
	}
	return parseExpoSdkMajor(
		record.dependencies?.expo ?? record.devDependencies?.expo
	)
}

export async function requireEnvironmentIfNeeded(
	input: Pick<OperationInput, 'environment' | 'readPackageJson'>
) {
	if (input.environment) return
	const major = await readExpoSdkMajor(input.readPackageJson)
	if (major !== null && major >= 55) {
		throw new Error(
			'EAS Update requires --environment for Expo SDK 55+. Pass --environment <name> or set build.<profile>.environment in eas.json.'
		)
	}
}

async function runHook(
	name: 'pre-update' | 'post-update',
	command: string | undefined,
	commandRunner: CommandRunner
) {
	if (!command) return
	await stage(name, () => commandRunner(['bash', '-c', command]))
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
	if (input.exportSourceMaps) {
		await stage('ota export', async () => {
			await commandRunner(sourceMapExportCommand(input.platform))
			if (input.dryRun !== true) {
				await assertSourceMaps(input.hasSourceMaps)
			}
		})
	}
	await runHook('pre-update', input.preUpdate, commandRunner)
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
	command.push(
		...mergeUpdateArgs(
			splitArgs(input.updateExtraArgs),
			input.exportSourceMaps === true
		)
	)
	await stage('ota update', () => commandRunner(command))
	await runHook('post-update', input.postUpdate, commandRunner)
}

/** Queues the build and reports the build EAS started (none in a dry run). */
async function queueNativeBuild(
	input: OperationInput,
	commandRunner: CommandRunner
): Promise<OperationResult> {
	const command = easCommand(
		'build',
		'--platform',
		input.platform,
		'--profile',
		input.profile,
		'--non-interactive',
		'--no-wait',
		'--json'
	)
	if (input.autoSubmit) {
		command.push('--auto-submit')
	}
	const output = await stage('native build', () => commandRunner(command))
	// The build is queued; an unreadable record only loses the outputs.
	try {
		const queued = output.trim() ? parseBuildList(output)[0] : undefined
		if (queued) input.onQueuedBuild?.(queued)
	} catch (error) {
		process.stderr.write(
			`Warning: could not read the queued build from eas build --json: ${error instanceof Error ? error.message : String(error)}\n`
		)
	}
	return 'native-build'
}

async function resolveRuntimeVersion(
	input: OperationInput,
	commandRunner: CommandRunner
): Promise<string> {
	if (input.runtimeVersion) return input.runtimeVersion
	if (input.fingerprint) return input.fingerprint
	return stage('fingerprint', () => generateFingerprint(input, commandRunner))
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
			const group = input.group
			await requireEnvironmentIfNeeded(input)
			await stage('recovery', () =>
				execute(
					easCommand(
						'update:republish',
						'--group',
						group,
						'--platform',
						input.platform,
						'--message',
						updateMessage(input),
						'--non-interactive'
					)
				)
			)
			return 'recovery'
		}
		case 'rollback-embedded': {
			await requireEnvironmentIfNeeded(input)
			const runtimeVersion = await resolveRuntimeVersion(input, commandRunner)
			await stage('recovery', () =>
				execute(
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
			)
			return 'recovery'
		}
		case 'force-native':
			return queueNativeBuild(input, execute)
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
			return queueNativeBuild(input, execute)
		case 'ota':
			await publishUpdate(input, execute)
			return 'ota'
		default: {
			const _exhaustive: never = input.deployType
			throw new Error(`Unsupported deploy type: ${_exhaustive}`)
		}
	}
}

export async function writeOperateGitHubOutput(
	result: OperationResult,
	queuedBuild?: EASBuild
) {
	await appendGitHubOutput({
		result,
		queued_build_id: queuedBuild?.id ?? '',
		queued_build_url: queuedBuild?.buildUrl ?? ''
	})
}
