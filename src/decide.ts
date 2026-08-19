import {
	DEFAULT_IMPACT_PATHS,
	type DeployType,
	type ReleasePlatform
} from './args'
import { appendGitHubOutput } from './github-output'
import {
	type CommandRunner,
	easCommand,
	getRecord,
	generateFingerprint,
	parseJson,
	runCaptured
} from './run'

export type EASBuildStatus =
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
	fingerprint?: string
	runtimeVersion?: string
}

export type ReleaseDecision = {
	deployType: DeployType
	nativeBuildPending: boolean
	changedFiles: string[]
	fingerprint: string | null
	build: EASBuild | null
}

export type DecisionInput = {
	base?: string
	head?: string
	profile: string
	platform: ReleasePlatform
	impactPaths: string[]
	ignoreExpoImpact?: boolean
}

const ACTIVE_BUILD_STATUSES: readonly EASBuildStatus[] = [
	'in-progress',
	'new',
	'in-queue',
	'pending-cancel'
]

const KNOWN_BUILD_STATUSES = new Set<string>([
	'finished',
	'in-progress',
	'new',
	'in-queue',
	'pending-cancel',
	'errored',
	'canceled'
])

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nestedString(
	record: Record<string, unknown>,
	...path: string[]
): string | undefined {
	let current: unknown = record
	for (const key of path) {
		if (!isRecord(current)) return undefined
		current = current[key]
	}
	return typeof current === 'string' && current.length > 0 ? current : undefined
}

function normalizeBuildStatus(value: string): EASBuildStatus | null {
	const status = value.toLowerCase().replaceAll('_', '-')
	if (KNOWN_BUILD_STATUSES.has(status)) {
		return status as EASBuildStatus
	}
	return null
}

function dashboardBuildUrl(
	record: Record<string, unknown>
): string | undefined {
	const ownerName = nestedString(record, 'app', 'ownerAccount', 'name')
	const slug = nestedString(record, 'app', 'slug')
	if (typeof record.id !== 'string' || !ownerName || !slug) {
		return undefined
	}
	return `https://expo.dev/accounts/${ownerName}/projects/${slug}/builds/${record.id}`
}

export function parseBuildList(output: string): EASBuild[] {
	const parsed = parseJson(output)
	if (!Array.isArray(parsed)) {
		throw new Error('EAS build:list did not return an array')
	}

	const builds: EASBuild[] = []
	for (const value of parsed) {
		const record = getRecord(value, 'EAS build')
		if (typeof record.id !== 'string' || typeof record.status !== 'string') {
			throw new Error('EAS build must include string id and status fields')
		}

		const status = normalizeBuildStatus(record.status)
		if (!status) {
			process.stderr.write(
				`Warning: ignoring EAS build ${record.id} with unsupported status ${record.status}\n`
			)
			continue
		}

		const buildUrl = dashboardBuildUrl(record)
		const fingerprint = nestedString(record, 'fingerprint', 'hash')
		const runtimeVersion = nestedString(record, 'runtime', 'version')

		builds.push({
			id: record.id,
			status,
			...(buildUrl ? { buildUrl } : {}),
			...(fingerprint ? { fingerprint } : {}),
			...(runtimeVersion ? { runtimeVersion } : {})
		})
	}

	return builds
}

export function isExpoImpactPath(
	path: string,
	impactPaths: readonly string[] = DEFAULT_IMPACT_PATHS
): boolean {
	return impactPaths.some((impactPath) => {
		const prefix = impactPath.endsWith('/')
			? impactPath.slice(0, -1)
			: impactPath
		return (
			path === prefix || path === impactPath || path.startsWith(`${prefix}/`)
		)
	})
}

export function hasExpoImpact(
	paths: string[],
	impactPaths: readonly string[] = DEFAULT_IMPACT_PATHS
): boolean {
	return paths.some((path) => isExpoImpactPath(path, impactPaths))
}

export function resolveBuildDecision(builds: EASBuild[]): {
	deployType: Exclude<DeployType, 'none'>
	nativeBuildPending: boolean
	build: EASBuild | null
} {
	const finished = builds.find((build) => build.status === 'finished')
	if (finished) {
		return { deployType: 'ota', nativeBuildPending: false, build: finished }
	}

	const inProgress = builds.find((build) =>
		ACTIVE_BUILD_STATUSES.includes(build.status)
	)
	if (inProgress) {
		return {
			deployType: 'ota',
			nativeBuildPending: true,
			build: inProgress
		}
	}

	const newest = builds[0]
	if (newest?.status === 'errored') {
		const location = newest.buildUrl ?? newest.id
		throw new Error(
			`The most recent native build for this fingerprint failed (${location}). Fix the failure or use --operation force-native to queue another build.`
		)
	}

	return { deployType: 'native', nativeBuildPending: false, build: null }
}

async function getChangedFiles(
	input: DecisionInput,
	commandRunner: CommandRunner
): Promise<{ files: string[]; unreachable: boolean }> {
	const head = input.head
	if (!input.base || !head || /^0+$/.test(input.base)) {
		return { files: [], unreachable: true }
	}

	try {
		const output = await commandRunner([
			'git',
			'-c',
			'diff.relative=false',
			'diff',
			'--name-only',
			input.base,
			head
		])
		return {
			files: output
				.split('\n')
				.map((path) => path.trim())
				.filter(Boolean),
			unreachable: false
		}
	} catch {
		return { files: [], unreachable: true }
	}
}

async function getMatchingBuilds(
	input: DecisionInput,
	fingerprint: string,
	commandRunner: CommandRunner
): Promise<EASBuild[]> {
	return parseBuildList(
		await commandRunner(
			easCommand(
				'build:list',
				'--platform',
				input.platform,
				'--build-profile',
				input.profile,
				'--fingerprint-hash',
				fingerprint,
				'--limit',
				'20',
				'--json',
				'--non-interactive'
			)
		)
	)
}

export async function decideRelease(
	input: DecisionInput,
	commandRunner: CommandRunner = runCaptured
): Promise<ReleaseDecision> {
	const { files: changedFiles, unreachable } = await getChangedFiles(
		input,
		commandRunner
	)

	if (
		!input.ignoreExpoImpact &&
		!unreachable &&
		!hasExpoImpact(changedFiles, input.impactPaths)
	) {
		return {
			deployType: 'none',
			nativeBuildPending: false,
			changedFiles,
			fingerprint: null,
			build: null
		}
	}

	const fingerprint = await generateFingerprint(input, commandRunner)
	const resolved = resolveBuildDecision(
		await getMatchingBuilds(input, fingerprint, commandRunner)
	)

	return {
		deployType: resolved.deployType,
		nativeBuildPending: resolved.nativeBuildPending,
		changedFiles,
		fingerprint,
		build: resolved.build
	}
}

export async function writeDecideGitHubOutput(decision: ReleaseDecision) {
	await appendGitHubOutput({
		deploy_type: decision.deployType,
		native_build_pending: String(decision.nativeBuildPending),
		changed: String(decision.deployType !== 'none'),
		fingerprint: decision.fingerprint ?? '',
		build_id: decision.build?.id ?? '',
		build_url: decision.build?.buildUrl ?? ''
	})
}
