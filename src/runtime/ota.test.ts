import { beforeEach, describe, expect, mock, test } from 'bun:test'

let available = true
let isNew = true
let manifestId = 'update-1'
const reloadAsync = mock(async () => {})
let appStateListener: ((state: string) => void) | undefined

mock.module('expo-updates', () => ({
	isEnabled: true,
	updateId: 'running-update',
	runtimeVersion: 'fp-abc',
	channel: 'production',
	createdAt: new Date(0),
	isEmbeddedLaunch: false,
	checkForUpdateAsync: async () => ({ isAvailable: available }),
	fetchUpdateAsync: async () => ({ isNew, manifest: { id: manifestId } }),
	reloadAsync
}))
mock.module('react-native', () => ({
	AppState: {
		addEventListener: (_: string, listener: (state: string) => void) => {
			appStateListener = listener
			return { remove: () => (appStateListener = undefined) }
		}
	}
}))
// Just enough React for the hook: stable refs and an effect that runs once.
const refs: { current: unknown }[] = []
let ref = 0
let cleanup: (() => void) | undefined
const React = await import('react')
mock.module('react', () => ({
	...React,
	useRef: (initial: unknown) => {
		refs[ref] ??= { current: initial }
		return refs[ref++]
	},
	useEffect: (effect: () => (() => void) | undefined) => {
		cleanup = effect() ?? undefined
	}
}))

const { checkForOTAUpdate, getReleaseInfo, useOTAUpdates } = await import(
	'./ota'
)

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
	available = true
	isNew = true
	manifestId = 'update-1'
	reloadAsync.mockClear()
	refs.length = 0
	cleanup?.()
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

describe('getReleaseInfo', () => {
	test('reads the running release', () => {
		expect(getReleaseInfo()).toEqual({
			updateId: 'running-update',
			runtimeVersion: 'fp-abc',
			channel: 'production',
			createdAt: new Date(0),
			isEmbeddedLaunch: false
		})
	})
})

describe('useOTAUpdates', () => {
	const render = (
		onUpdateReady: () => void,
		options: Parameters<typeof useOTAUpdates>[1]
	) => {
		ref = 0
		useOTAUpdates(onUpdateReady, { enabled: true, ...options })
	}

	test('rechecks on foreground and offers each update once', async () => {
		const onUpdateReady = mock()
		render(onUpdateReady, { recheckOnForeground: 0 })
		await flush()
		expect(onUpdateReady).toHaveBeenCalledTimes(1)

		appStateListener?.('active')
		await flush()
		expect(onUpdateReady).toHaveBeenCalledTimes(1)

		manifestId = 'update-2'
		appStateListener?.('background')
		appStateListener?.('active')
		await flush()
		expect(onUpdateReady).toHaveBeenCalledTimes(2)
	})

	test('waits the given minutes between checks', async () => {
		const onUpdateReady = mock()
		render(onUpdateReady, { recheckOnForeground: 30 })
		await flush()
		manifestId = 'update-2'
		appStateListener?.('active')
		await flush()
		expect(onUpdateReady).toHaveBeenCalledTimes(1)
	})

	test('does not listen for the foreground by default', () => {
		render(mock(), {})
		expect(appStateListener).toBeUndefined()
	})
})
