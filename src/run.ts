import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type CommandRunner = (command: string[]) => Promise<string>

/**
 * The app's own eas-cli (node_modules/.bin, searched up to the repository
 * root) wins over PATH: its lockfile pins the version. `EAS_BIN` wins over both.
 */
export function easCommand(...args: string[]): string[] {
	const bin = process.env.EAS_BIN?.trim()
	return [bin && bin.length > 0 ? bin : (localBin('eas') ?? 'eas'), ...args]
}

const localBins = new Map<string, string | null>()

/** `node_modules/.bin/<name>` from the working directory up to the repository root. */
export function localBin(name: string): string | null {
	const cwd = process.cwd()
	const cacheKey = `${cwd}\0${name}`
	const cached = localBins.get(cacheKey)
	if (cached !== undefined) return cached
	let bin: string | null = null
	for (let dir = cwd; ; dir = dirname(dir)) {
		const candidate = join(dir, 'node_modules', '.bin', name)
		if (existsSync(candidate)) {
			bin = candidate
			break
		}
		if (existsSync(join(dir, '.git')) || dirname(dir) === dir) break
	}
	localBins.set(cacheKey, bin)
	return bin
}

/** A failed command. `tail` holds its last non-empty output lines. */
export class CommandError extends Error {
	constructor(
		message: string,
		readonly tail: string[]
	) {
		super(message)
		this.name = 'CommandError'
	}
}

const ERROR_TAIL_LINES = 20

function lastLines(output: string, count = ERROR_TAIL_LINES): string[] {
	return output
		.split('\n')
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0)
		.slice(-count)
}

// After the command exits, a background process it started can keep the
// pipes open; stop reading after this long instead of waiting for it.
const DRAIN_AFTER_EXIT_MS = 1000

function collect(
	stream: ReadableStream<Uint8Array>,
	echo: NodeJS.WriteStream | null,
	sink: string[]
) {
	const reader = stream.getReader()
	const decoder = new TextDecoder()
	let text = ''
	const done = (async () => {
		try {
			for (;;) {
				const { value, done } = await reader.read()
				if (done) break
				echo?.write(value)
				const part = decoder.decode(value, { stream: true })
				text += part
				sink.push(part)
			}
		} catch {}
		const rest = decoder.decode()
		sink.push(rest)
		text += rest
	})()
	return {
		done,
		stop: () => reader.cancel().catch(() => undefined),
		text: () => text
	}
}

async function spawn(
	command: string[],
	echoStdout: boolean,
	echoStderr = true
) {
	const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' })
	// Both streams in arrival order, for the failure tail.
	const combined: string[] = []
	const out = collect(
		child.stdout,
		echoStdout ? process.stdout : null,
		combined
	)
	// stderr reaches the log: EAS prints its warnings and progress there.
	const err = collect(
		child.stderr,
		echoStderr ? process.stderr : null,
		combined
	)
	const exitCode = await child.exited
	const drained = Promise.all([out.done, err.done])
	let timer: ReturnType<typeof setTimeout> | undefined
	const timedOut = await Promise.race([
		drained.then(() => false),
		new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(true), DRAIN_AFTER_EXIT_MS)
		})
	])
	clearTimeout(timer)
	if (timedOut) {
		await Promise.all([out.stop(), err.stop()])
		await drained
	}
	return {
		stdout: out.text(),
		stderr: err.text(),
		exitCode,
		tail: lastLines(combined.join(''))
	}
}

/** Runs a command for its stdout. stderr streams to the log. */
export async function runCaptured(command: string[]): Promise<string> {
	const { stdout, stderr, exitCode, tail } = await spawn(command, false)
	if (exitCode !== 0) {
		throw new CommandError(
			describeFailure(command, exitCode, { stderr, stdout }),
			tail
		)
	}
	return stdout
}

/** Like runCaptured, but prints nothing: for checks that quote the error. */
export async function runSilent(command: string[]): Promise<string> {
	const { stdout, stderr, exitCode, tail } = await spawn(command, false, false)
	if (exitCode !== 0) {
		throw new CommandError(
			describeFailure(command, exitCode, { stderr, stdout }),
			tail
		)
	}
	return stdout
}

/** Runs a command with its output in the log. Resolves its stdout. */
export async function runInherited(command: string[]): Promise<string> {
	const { stdout, exitCode, tail } = await spawn(command, true)
	if (exitCode !== 0) {
		throw new CommandError(
			`Command failed with exit code ${exitCode}: ${quoteCommand(command)} (output above)`,
			tail
		)
	}
	return stdout
}

const OUTPUT_TAIL_LINES = 100

function tail(output: string): string {
	const lines = output.trimEnd().split('\n')
	if (lines.length <= OUTPUT_TAIL_LINES) return lines.join('\n')
	const omitted = lines.length - OUTPUT_TAIL_LINES
	return [
		`... (${omitted} earlier lines omitted)`,
		...lines.slice(-OUTPUT_TAIL_LINES)
	].join('\n')
}

// Both streams are kept: EAS can print only an upgrade notice on stderr while
// the real error lands on stdout (or the reverse). The command line holds no
// secrets; tokens reach EAS through the environment, which is never printed.
export function describeFailure(
	command: string[],
	exitCode: number,
	output: { stderr: string; stdout: string }
): string {
	const sections = [
		`Command failed with exit code ${exitCode}: ${quoteCommand(command)}`
	]
	if (output.stderr.trim()) sections.push(`stderr:\n${tail(output.stderr)}`)
	if (output.stdout.trim()) sections.push(`stdout:\n${tail(output.stdout)}`)
	if (sections.length === 1) sections.push('(no output)')
	return sections.join('\n')
}

/**
 * Parses the last JSON document in `output`. `preamble` is whatever came
 * before it: eas-cli prints warnings to stdout before it switches to JSON-only
 * output, for example when `npx expo config` failed and it fell back.
 */
export function parseJsonDocument(output: string): {
	value: unknown
	preamble: string
} {
	// A document starts at the beginning of the output or of a line; pretty
	// printed JSON indents everything after its first line.
	const starts = [0]
	for (const match of output.matchAll(/\n(?=[[{])/g)) {
		starts.push(match.index + 1)
	}
	for (const start of starts) {
		try {
			return {
				value: JSON.parse(output.slice(start)) as unknown,
				preamble: output.slice(0, start).trim()
			}
		} catch {}
	}
	throw new Error(`Expected JSON output, received:\n${tail(output)}`)
}

/** Parses JSON output, logging any text printed before it. */
export function parseJson(output: string): unknown {
	const { value, preamble } = parseJsonDocument(output)
	if (preamble) process.stderr.write(`${preamble}\n`)
	return value
}

export function getRecord(
	value: unknown,
	context: string
): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error(`${context} must be an object`)
	}
	return value as Record<string, unknown>
}

export function parseFingerprintHash(output: string): string {
	const record = getRecord(parseJsonDocument(output).value, 'EAS fingerprint')
	if (typeof record.hash !== 'string' || record.hash.length === 0) {
		throw new Error('EAS fingerprint output did not contain a full hash')
	}
	return record.hash
}

export function quoteCommand(command: string[]): string {
	return command
		.map((part) =>
			/[\s"]/.test(part) ? `"${part.replaceAll('"', '\\"')}"` : part
		)
		.join(' ')
}

export function dryRunCommand(command: string[]): void {
	process.stderr.write(`[dry-run] ${quoteCommand(command)}\n`)
}

export type Stage =
	| 'doctor'
	| 'diff'
	| 'fingerprint'
	| 'build list'
	| 'errored build'
	| 'fingerprint diff'
	| 'native build'
	| 'ota export'
	| 'ota update'
	| 'pre-update'
	| 'post-update'
	| 'recovery'

/** A failed release step: what ran, and the last lines it printed. */
export class StageError extends Error {
	constructor(
		readonly stage: Stage,
		message: string,
		readonly tail: string[] = []
	) {
		super(message)
		this.name = 'StageError'
	}
}

/** Runs one release step, logs how long it took, and names it on failure. */
export async function stage<T>(name: Stage, run: () => Promise<T>): Promise<T> {
	const started = performance.now()
	try {
		return await run()
	} catch (error) {
		if (error instanceof StageError) throw error
		throw new StageError(
			name,
			error instanceof Error ? error.message : String(error),
			error instanceof CommandError ? error.tail : []
		)
	} finally {
		const seconds = ((performance.now() - started) / 1000).toFixed(1)
		process.stderr.write(`[expo-release] ${name}: ${seconds}s\n`)
	}
}

/**
 * The fingerprint fails when eas-cli printed anything before its JSON: that
 * means the app config did not load and eas-cli fell back to its bundled
 * `@expo/config`, whose fingerprint may not be the one EAS builds with.
 * `explainConfig` runs `expo config` to surface the real error.
 */
export async function generateFingerprint(
	input: { platform: string; profile: string },
	commandRunner: CommandRunner,
	explainConfig?: () => Promise<string>
): Promise<string> {
	const output = await commandRunner(
		easCommand(
			'fingerprint:generate',
			'--platform',
			input.platform,
			'--build-profile',
			input.profile,
			'--json',
			'--non-interactive'
		)
	)
	const { preamble } = parseJsonDocument(output)
	if (preamble) {
		const reason = explainConfig ? await explainConfig() : ''
		throw new CommandError(
			[
				'eas fingerprint:generate could not load the app config and fell back to a default one, so its fingerprint may not match what EAS builds.',
				`eas-cli printed:\n${preamble}`,
				reason && `expo config said:\n${reason}`
			]
				.filter(Boolean)
				.join('\n'),
			lastLines(reason || preamble)
		)
	}
	return parseFingerprintHash(output)
}
