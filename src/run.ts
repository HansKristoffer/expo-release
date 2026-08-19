export type CommandRunner = (command: string[]) => Promise<string>

export function easCommand(...args: string[]): string[] {
	const bin = process.env.EAS_BIN?.trim()
	return [bin && bin.length > 0 ? bin : 'eas', ...args]
}

export async function runCaptured(command: string[]): Promise<string> {
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

export async function runInherited(command: string[]): Promise<string> {
	const child = Bun.spawn(command, { stdout: 'inherit', stderr: 'inherit' })
	const exitCode = await child.exited
	if (exitCode !== 0) {
		throw new Error(`Command failed (${command.join(' ')})`)
	}
	return ''
}

export function parseJson(output: string): unknown {
	try {
		return JSON.parse(output) as unknown
	} catch {
		throw new Error(`Expected JSON output, received:\n${output}`)
	}
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
	const record = getRecord(parseJson(output), 'EAS fingerprint')
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

export async function generateFingerprint(
	input: { platform: string; profile: string },
	commandRunner: CommandRunner
): Promise<string> {
	return parseFingerprintHash(
		await commandRunner(
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
	)
}
