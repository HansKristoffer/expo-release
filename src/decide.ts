import {
	DEFAULT_IMPACT_PATHS,
	parseBoolean,
	parseFlagArgs,
	parseImpactPaths,
	parsePlatform,
	type ReleasePlatform
} from './args'
import { appendGitHubOutput } from './github-output'

export type ReleaseAction = 'skip' | 'ota' | 'build' | 'build-in-progress'

type EASBuildStatus =
	| 'finished'
	| 'in-progress'
	| 'new'
	| 'in-queue'
	| 'pending-cancel'
	| 'errored'
	| 'canceled'

export type EASBuild = {
	id: string
	status: EASBuildStatus
	buildUrl?: string
}

export type ReleaseDecision = {
	action: ReleaseAction
	changedFiles: string[]
	fingerprint: string | null
	build: EASBuild | null
}

export type DecisionInput = {
	base: string
	head: string
	profile: string
	platform: ReleasePlatform
	impactPaths: string[]
	ignoreExpoImpact?: boolean
}

type CommandRunner = (command: string[]) => Promise<string>

const ACTIVE_BUILD_STATUSES = [
	'in-progress',
	'new',
	'in-queue',
	'pending-cancel'
] as const

const DECIDE_USAGE =
	'Usage: expo-release decide --base <sha> --head <sha> --profile <profile> [--platform ios] [--impact-paths apps/expo/] [--ignore-expo-impact true]'

async function run(command: string[]): Promise<string> {
	const child = Bun.spawn(command, {
		stdout: 'pipe',
		stderr: 'pipe'
	})
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited
	])
	if (exitCode !== 0) {
		throw new Error(
			`Command failed (${command.join(' ')}):\n${stderr || stdout}`
		)
	}
	return stdout
}

function parseJson(output: string): unknown {
	const lines = output.split('\n')
	const startIndex = lines.findIndex((line) => {
		const trimmed = line.trim()
		return trimmed.startsWith('{') || trimmed.startsWith('[')
	})
	const json =
		startIndex === -1 ? output.trim() : lines.slice(startIndex).join('\n')

	try {
		return JSON.parse(json) as unknown
	} catch {
		throw new Error(`Expected JSON output, received:\n${output}`)
	}
}

function getRecord(value: unknown, context: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error(`${context} must be an object`)
	}
	return value as Record<string, unknown>
}

function normalizeBuildStatus(value: string): EASBuildStatus {
	const status = value.toLowerCase().replaceAll('_', '-')
	switch (status) {
		case 'finished':
		case 'in-progress':
		case 'new':
		case 'in-queue':
		case 'pending-cancel':
		case 'errored':
		case 'canceled':
			return status
		default: {
			const _exhaustive: never = status as never
			void _exhaustive
			throw new Error(`Unsupported EAS build status: ${value}`)
		}
	}
}

function parseBuildList(output: string): EASBuild[] {
	const parsed = parseJson(output)
	if (!Array.isArray(parsed)) {
		throw new Error('EAS build:list did not return an array')
	}

	return parsed.map((value) => {
		const record = getRecord(value, 'EAS build')
		if (typeof record.id !== 'string' || typeof record.status !== 'string') {
			throw new Error('EAS build must include string id and status fields')
		}

		const buildUrl =
			typeof record.buildDetailsPageUrl === 'string'
				? record.buildDetailsPageUrl
				: typeof record.detailsPageUrl === 'string'
					? record.detailsPageUrl
					: typeof record.buildUrl === 'string'
						? record.buildUrl
						: undefined

		return {
			id: record.id,
			status: normalizeBuildStatus(record.status),
			...(buildUrl ? { buildUrl } : {})
		}
	})
}

function parseFingerprint(output: string): string {
	const record = getRecord(parseJson(output), 'EAS fingerprint')
	if (typeof record.hash !== 'string' || record.hash.length === 0) {
		throw new Error('EAS fingerprint output did not contain a full hash')
	}
	return record.hash
}

export function isExpoImpactPath(
	path: string,
	impactPaths: readonly string[] = DEFAULT_IMPACT_PATHS
): boolean {
	return impactPaths.some(
		(impactPath) => path === impactPath || path.startsWith(impactPath)
	)
}

export function hasExpoImpact(
	paths: string[],
	impactPaths: readonly string[] = DEFAULT_IMPACT_PATHS
): boolean {
	return paths.some((path) => isExpoImpactPath(path, impactPaths))
}

export function resolveBuildAction(builds: EASBuild[]): {
	action: Exclude<ReleaseAction, 'skip'>
	build: EASBuild | null
} {
	const finished = builds.find((build) => build.status === 'finished')
	if (finished) {
		return { action: 'ota', build: finished }
	}

	const inProgress = builds.find((build) =>
		ACTIVE_BUILD_STATUSES.includes(
			build.status as (typeof ACTIVE_BUILD_STATUSES)[number]
		)
	)
	if (inProgress) {
		return { action: 'build-in-progress', build: inProgress }
	}

	return { action: 'build', build: null }
}

async function getMatchingBuilds(
	input: DecisionInput,
	fingerprint: string,
	commandRunner: CommandRunner
): Promise<EASBuild[]> {
	const baseCommand = [
		'bunx',
		'eas',
		'build:list',
		'--platform',
		input.platform,
		'--build-profile',
		input.profile,
		'--fingerprint-hash',
		fingerprint,
		'--limit',
		'1',
		'--json',
		'--non-interactive'
	]

	const finished = parseBuildList(
		await commandRunner([...baseCommand, '--status', 'finished'])
	)
	if (finished.length > 0) return finished

	for (const status of ACTIVE_BUILD_STATUSES) {
		const active = parseBuildList(
			await commandRunner([...baseCommand, '--status', status])
		)
		if (active.length > 0) return active
	}

	return []
}

export async function decideRelease(
	input: DecisionInput,
	commandRunner: CommandRunner = run
): Promise<ReleaseDecision> {
	const changedFiles = (
		await commandRunner(['git', 'diff', '--name-only', input.base, input.head])
	)
		.split('\n')
		.map((path) => path.trim())
		.filter(Boolean)

	if (
		!input.ignoreExpoImpact &&
		!hasExpoImpact(changedFiles, input.impactPaths)
	) {
		return {
			action: 'skip',
			changedFiles,
			fingerprint: null,
			build: null
		}
	}

	const fingerprint = parseFingerprint(
		await commandRunner([
			'bunx',
			'eas',
			'fingerprint:generate',
			'--platform',
			input.platform,
			'--build-profile',
			input.profile,
			'--json',
			'--non-interactive'
		])
	)
	const resolved = resolveBuildAction(
		await getMatchingBuilds(input, fingerprint, commandRunner)
	)

	return {
		action: resolved.action,
		changedFiles,
		fingerprint,
		build: resolved.build
	}
}

export function parseDecideArgs(args: string[]): DecisionInput {
	const values = parseFlagArgs(args, DECIDE_USAGE)
	const base = values.get('base')
	const head = values.get('head')
	const profile = values.get('profile')
	if (!base || !head || !profile) {
		throw new Error(DECIDE_USAGE)
	}

	return {
		base,
		head,
		profile,
		platform: parsePlatform(values.get('platform')),
		impactPaths: parseImpactPaths(values.get('impact-paths')),
		ignoreExpoImpact: parseBoolean(values.get('ignore-expo-impact'), false)
	}
}

export async function writeDecideGitHubOutput(decision: ReleaseDecision) {
	await appendGitHubOutput([
		`action=${decision.action}`,
		`changed=${String(decision.action !== 'skip')}`,
		`fingerprint=${decision.fingerprint ?? ''}`,
		`build_id=${decision.build?.id ?? ''}`,
		`build_url=${decision.build?.buildUrl ?? ''}`
	])
}
