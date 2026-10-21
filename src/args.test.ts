import { describe, expect, test } from 'bun:test'
import { shouldIgnoreExpoImpact } from './args'

describe('shouldIgnoreExpoImpact', () => {
	test('ignores impact for retry-ota', () => {
		expect(
			shouldIgnoreExpoImpact({
				ignoreExpoImpact: false,
				operation: 'retry-ota'
			})
		).toBe(true)
	})

	test('ignores impact for a dispatched deploy', () => {
		const previous = process.env.GITHUB_EVENT_NAME
		process.env.GITHUB_EVENT_NAME = 'workflow_dispatch'
		try {
			expect(
				shouldIgnoreExpoImpact({
					ignoreExpoImpact: false,
					operation: 'deploy'
				})
			).toBe(true)
		} finally {
			if (previous === undefined) {
				delete process.env.GITHUB_EVENT_NAME
			} else {
				process.env.GITHUB_EVENT_NAME = previous
			}
		}
	})
})
