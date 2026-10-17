import { describe, expect, test } from 'bun:test'
import { runCaptured } from './run'

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
