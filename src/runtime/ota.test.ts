import { beforeEach, describe, expect, mock, test } from 'bun:test'

let available = true
let isNew = true
const reloadAsync = mock(async () => {})

mock.module('expo-updates', () => ({
	isEnabled: true,
	checkForUpdateAsync: async () => ({ isAvailable: available }),
	fetchUpdateAsync: async () => ({ isNew }),
	reloadAsync
}))

const { checkForOTAUpdate } = await import('./ota')

beforeEach(() => {
	available = true
	isNew = true
	reloadAsync.mockClear()
})

describe('checkForOTAUpdate', () => {
	test('offers a reload once a new update is downloaded', async () => {
		const onUpdateReady = mock()
		expect(await checkForOTAUpdate(onUpdateReady)).toBe(true)

		const reload = onUpdateReady.mock.lastCall?.[0]
		await reload()
		expect(reloadAsync).toHaveBeenCalledTimes(1)
	})

	test('stays quiet without an update', async () => {
		available = false
		const onUpdateReady = mock()
		expect(await checkForOTAUpdate(onUpdateReady)).toBe(false)
		expect(onUpdateReady).not.toHaveBeenCalled()
	})

	test('stays quiet when the fetched update is already running', async () => {
		isNew = false
		const onUpdateReady = mock()
		expect(await checkForOTAUpdate(onUpdateReady)).toBe(false)
		expect(onUpdateReady).not.toHaveBeenCalled()
	})
})
