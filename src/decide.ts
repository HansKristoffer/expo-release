import {
	DEFAULT_IMPACT_PATHS,
	type DeployType,
	type ReleasePlatform
} from './args'
import { appendGitHubOutput } from './github-output'
import {
	type CommandRunner,
	easCommand,
	generateFingerprint,
	getRecord,
	parseJson,
	parseJsonDocument,
	runCaptured,
	StageError,
	stage
} from './run'
import { expoCommand } from './source-maps'

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
	/** Why EAS failed the build, for an errored one. */
	error?: string
}

/** Why the decision came out the way it did. */
export type DecisionReason =
	| 'no-impact-path'
	| 'finished-build'
	| 'build-in-progress'
	| 'no-build-for-fingerprint'

/** What changed since the profile's last finished build, for a native decision. */
export type FingerprintDiff = {
	buildId: string
	buildUrl?: string
	/** `changed <path>`, `added <path>` or `removed <path>`; contents sources by id. */
	sources: string[]
}

export type ReleaseDecision = {
	deployType: DeployType
	reason: DecisionReason
	nativeBuildPending: boolean
	changedFiles: string[]
	fingerprint: string | null
	build: EASBuild | null
	fingerprintDiff?: FingerprintDiff | null
}

export type DecisionInput = {
	base?: string
	head?: string
	profile: string
	platform: ReleasePlatform
	impactPaths: string[]
	ignoreExpoImpact?: boolean
	/** Passed to `eas fingerprint:compare` when explaining a native decision. */
	environment?: string
	/** Runs once the diff says EAS is needed, before the first EAS command. */
	preflight?: () => Promise<void>
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

// eas-cli prints its GraphQL BuildFragment: `project.ownerAccount.name`,
// `project.slug` and a top-level `runtimeVersion`. `app` and `runtime` are kept
// as fallbacks for older output.
function dashboardBuildUrl(
	record: Record<string, unknown>
): string | undefined {
	const ownerName =
		nestedString(record, 'project', 'ownerAccount', 'name') ??
		nestedString(record, 'app', 'ownerAccount', 'name')
	const slug =
		nestedString(record, 'project', 'slug') ??
		nestedString(record, 'app', 'slug')
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
		const runtimeVersion =
			nestedString(record, 'runtimeVersion') ??
			nestedString(record, 'runtime', 'version')
		const errorCode = nestedString(record, 'error', 'errorCode')
		const errorMessage = nestedString(record, 'error', 'message')
		const error = [errorCode, errorMessage].filter(Boolean).join(': ')

		builds.push({
			id: record.id,
			status,
			...(buildUrl ? { buildUrl } : {}),
			...(fingerprint ? { fingerprint } : {}),
			...(runtimeVersion ? { runtimeVersion } : {}),
			...(error ? { error } : {})
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
	reason: Exclude<DecisionReason, 'no-impact-path'>
	nativeBuildPending: boolean
	build: EASBuild | null
} {
	const finished = builds.find((build) => build.status === 'finished')
	if (finished) {
		return {
			deployType: 'ota',
			reason: 'finished-build',
			nativeBuildPending: false,
			build: finished
		}
	}

	const inProgress = builds.find((build) =>
		ACTIVE_BUILD_STATUSES.includes(build.status)
	)
	if (inProgress) {
		return {
			deployType: 'ota',
			reason: 'build-in-progress',
			nativeBuildPending: true,
			build: inProgress
		}
	}

	const newest = builds[0]
	if (newest?.status === 'errored') {
		const lines = [
			`The newest native build for this fingerprint failed on EAS${newest.error ? `: ${newest.error}` : ` (build ${newest.id})`}`,
			newest.buildUrl,
			'Fix it, then run the workflow with operation force-native.'
		].filter((line): line is string => Boolean(line))
		throw new StageError('errored build', lines.join('\n'), lines)
	}

	return {
		deployType: 'native',
		reason: 'no-build-for-fingerprint',
		nativeBuildPending: false,
		build: null
	}
}

async function readPullRequestBase(): Promise<string | undefined> {
	const path = process.env.GITHUB_EVENT_PATH
	if (!path) return undefined
	try {
		const event = (await Bun.file(path).json()) as {
			pull_request?: { base?: { sha?: unknown } }
		}
		const sha = event.pull_request?.base?.sha
		return typeof sha === 'string' && sha ? sha : undefined
	} catch {
		return undefined
	}
}

/**
 * Without `--base`: the merge base with the PR's base branch on a pull request
 * (`github.event.before` there is the previous push, not the base), else
 * `github.event.before`.
 */
export async function defaultBase(
	head: string | undefined,
	commandRunner: CommandRunner
): Promise<string | undefined> {
	const event = process.env.GITHUB_EVENT_NAME
	if (event === 'pull_request' || event === 'pull_request_target') {
		const base = await readPullRequestBase()
		if (base && head) {
			try {
				const mergeBase = (
					await commandRunner(['git', 'merge-base', base, head])
				).trim()
				if (mergeBase) return mergeBase
			} catch {}
		}
		if (base) return base
	}
	return process.env.GITHUB_EVENT_BEFORE?.trim() || undefined
}

async function getChangedFiles(
	input: DecisionInput,
	commandRunner: CommandRunner
): Promise<{ files: string[]; unreachable: boolean }> {
	const head = input.head
	const base = input.base ?? (await defaultBase(head, commandRunner))
	if (!base || !head || /^0+$/.test(base)) {
		return { files: [], unreachable: true }
	}

	try {
		const output = await commandRunner([
			'git',
			'-c',
			'diff.relative=false',
			'diff',
			'--name-only',
			base,
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

type FingerprintSource = {
	type?: unknown
	filePath?: unknown
	id?: unknown
	hash?: unknown
}

function fingerprintSources(value: unknown): Map<string, unknown> {
	const sources = (value as { sources?: unknown } | null)?.sources
	const map = new Map<string, unknown>()
	if (!Array.isArray(sources)) return map
	for (const source of sources as FingerprintSource[]) {
		const key =
			source.type === 'contents' ? source.id : (source.filePath ?? source.id)
		if (typeof key === 'string') map.set(key, source.hash ?? null)
	}
	return map
}

const MAX_DIFF_SOURCES = 30

/** Changed sources between the two fingerprints `eas fingerprint:compare --json` prints. */
export function diffFingerprintSources(compare: unknown): string[] {
	const record = getRecord(compare, 'EAS fingerprint:compare')
	const before = fingerprintSources(record.fingerprint1)
	const after = fingerprintSources(record.fingerprint2)
	const lines: string[] = []
	for (const [key, hash] of after) {
		if (!before.has(key)) lines.push(`added ${key}`)
		else if (before.get(key) !== hash) lines.push(`changed ${key}`)
	}
	for (const key of before.keys()) {
		if (!after.has(key)) lines.push(`removed ${key}`)
	}
	if (lines.length <= MAX_DIFF_SOURCES) return lines
	return [
		...lines.slice(0, MAX_DIFF_SOURCES),
		`... and ${lines.length - MAX_DIFF_SOURCES} more`
	]
}

/**
 * Compares the current fingerprint with the profile's last finished build.
 * Two extra EAS calls, made only for a native decision. A failure here only
 * loses the explanation, never the release.
 */
async function explainNativeDecision(
	input: DecisionInput,
	commandRunner: CommandRunner
): Promise<FingerprintDiff | null> {
	try {
		return await stage('fingerprint diff', async () => {
			const [last] = parseBuildList(
				await commandRunner(
					easCommand(
						'build:list',
						'--platform',
						input.platform,
						'--build-profile',
						input.profile,
						'--status',
						'finished',
						'--limit',
						'1',
						'--json',
						'--non-interactive'
					)
				)
			)
			if (!last) return null
			const command = easCommand(
				'fingerprint:compare',
				'--build-id',
				last.id,
				'--json',
				'--non-interactive'
			)
			if (input.environment) command.push('--environment', input.environment)
			const { value } = parseJsonDocument(await commandRunner(command))
			return {
				buildId: last.id,
				...(last.buildUrl ? { buildUrl: last.buildUrl } : {}),
				sources: diffFingerprintSources(value)
			}
		})
	} catch (error) {
		process.stderr.write(
			`Warning: could not compare the fingerprint with the last finished build: ${error instanceof Error ? error.message : String(error)}\n`
		)
		return null
	}
}

async function explainConfigFailure(
	commandRunner: CommandRunner
): Promise<string> {
	try {
		await commandRunner(expoCommand('config', '--json'))
		return ''
	} catch (error) {
		return error instanceof Error ? error.message : String(error)
	}
}

export async function decideRelease(
	input: DecisionInput,
	commandRunner: CommandRunner = runCaptured
): Promise<ReleaseDecision> {
	const { files: changedFiles, unreachable } = await stage('diff', () =>
		getChangedFiles(input, commandRunner)
	)

	if (
		!input.ignoreExpoImpact &&
		!unreachable &&
		!hasExpoImpact(changedFiles, input.impactPaths)
	) {
		return {
			deployType: 'none',
			reason: 'no-impact-path',
			nativeBuildPending: false,
			changedFiles,
			fingerprint: null,
			build: null
		}
	}

	await input.preflight?.()
	const fingerprint = await stage('fingerprint', () =>
		generateFingerprint(input, commandRunner, () =>
			explainConfigFailure(commandRunner)
		)
	)
	const builds = await stage('build list', () =>
		getMatchingBuilds(input, fingerprint, commandRunner)
	)
	const resolved = resolveBuildDecision(builds)

	return {
		deployType: resolved.deployType,
		reason: resolved.reason,
		nativeBuildPending: resolved.nativeBuildPending,
		changedFiles,
		fingerprint,
		build: resolved.build,
		...(resolved.deployType === 'native'
			? { fingerprintDiff: await explainNativeDecision(input, commandRunner) }
			: {})
	}
}

export async function writeDecideGitHubOutput(decision: ReleaseDecision) {
	await appendGitHubOutput({
		deploy_type: decision.deployType,
		native_build_pending: String(decision.nativeBuildPending),
		changed: String(decision.deployType !== 'none'),
		fingerprint: decision.fingerprint ?? '',
		build_id: decision.build?.id ?? '',
		build_url: decision.build?.buildUrl ?? '',
		reason: decision.reason,
		changed_sources: decision.fingerprintDiff?.sources.join('\n') ?? '',
		compared_build_url:
			decision.fingerprintDiff?.buildUrl ??
			decision.fingerprintDiff?.buildId ??
			''
	})
}
