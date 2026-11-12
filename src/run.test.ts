import { describe, expect, test } from 'bun:test'
import {
	CommandError,
	parseJsonDocument,
	runCaptured,
	runInherited,
	StageError,
	stage
} from './run'

describe('runCaptured', () => {
	test('a failure reports the exit code, stderr and stdout', async () => {
		const script =
			'echo "eas-cli 25.1.1 is available" >&2; echo "Error: project not configured"; exit 3'

		const error = await runCaptured(['sh', '-c', script]).catch((e) => e)

		expect(error).toBeInstanceOf(Error)
		expect(error.message).toContain('exit code 3')
		expect(error.message).toContain('eas-cli 25.1.1 is available')
		expect(error.message).toContain('Error: project not configured')
	})

	test('long output is trimmed to its last 100 lines', async () => {
		const error = await runCaptured([
			'sh',
			'-c',
			'seq 1 250 >&2; exit 1'
		]).catch((e) => e)

		expect(error.message).toContain('150 earlier lines omitted')
		expect(error.message).toContain('\n250')
		expect(error.message).not.toContain('\n150\n')
	})
})

describe('runInherited', () => {
	test('resolves stdout and keeps the last lines of a failure', async () => {
		expect(await runInherited(['sh', '-c', 'echo built'])).toBe('built\n')

		const error = await runInherited([
			'sh',
			'-c',
			'echo queued; echo "Credentials are not set up." >&2; exit 1'
		]).catch((e) => e)
		expect(error).toBeInstanceOf(CommandError)
		expect(error.message).toContain('(output above)')
		expect([...error.tail].sort()).toEqual([
			'Credentials are not set up.',
			'queued'
		])
	})
})

describe('parseJsonDocument', () => {
	test('reads the last document and returns what came before it', () => {
		expect(
			parseJsonDocument(
				'Warning: config failed\nfalling back\n{\n  "hash": "a"\n}\n'
			)
		).toEqual({
			value: { hash: 'a' },
			preamble: 'Warning: config failed\nfalling back'
		})
		expect(parseJsonDocument('[{"id":1}]')).toEqual({
			value: [{ id: 1 }],
			preamble: ''
		})
	})
})

describe('stage', () => {
	test('names the failed step', async () => {
		const error = await stage('native build', () =>
			runCaptured(['sh', '-c', 'echo nope >&2; exit 2'])
		).catch((e) => e)
		expect(error).toBeInstanceOf(StageError)
		expect(error.stage).toBe('native build')
		expect(error.tail).toEqual(['nope'])
	})
})
