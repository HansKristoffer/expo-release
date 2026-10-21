import { beforeEach, describe, expect, mock, test } from 'bun:test'

const calls: string[] = []
let granted = false
let requestGrants = true
let launchResponse: unknown = null
let tokenError: Error | null = null
let token = 'ExponentPushToken[abc]'
let rotateToken: ((devicePushToken: unknown) => void) | undefined
const removed: string[] = []

const notifications = {
	AndroidImportance: { HIGH: 4 },
	setNotificationHandler: mock(),
	setNotificationChannelAsync: mock(async () => null),
	getPermissionsAsync: async () => ({ granted }),
	requestPermissionsAsync: async () => {
		calls.push('request')
		granted = requestGrants
		return { granted }
	},
	getExpoPushTokenAsync: async () => {
		if (tokenError) throw tokenError
		return { data: token }
	},
	addPushTokenListener: (listener: (devicePushToken: unknown) => void) => {
		rotateToken = listener
		return { remove: () => removed.push('token') }
	},
	addNotificationReceivedListener: () => ({
		remove: () => removed.push('received')
	}),
	addNotificationResponseReceivedListener: () => ({
		remove: () => removed.push('response')
	}),
	getLastNotificationResponse: () => launchResponse
}

const mockDevice = (isDevice: boolean) =>
	mock.module('expo-device', () => ({ isDevice }))
mockDevice(true)
mock.module('expo-notifications', () => notifications)

// Just enough React to run the hook: state slots and dependency-aware effects.
const React = await import('react')
const slots: unknown[] = []
let slot = 0
mock.module('react', () => ({
	...React,
	useState: (initial: unknown) => {
		const index = slot++
		if (!(index in slots)) slots[index] = initial
		return [slots[index], (value: unknown) => (slots[index] = value)]
	},
	useCallback: (fn: unknown, deps: unknown[]) => {
		const index = slot++
		if (!changed(index, deps)) return (slots[index] as [unknown[], unknown])[1]
		slots[index] = [deps, fn]
		return fn
	},
	useEffect: (effect: () => void, deps: unknown[]) => {
		const index = slot++
		if (!changed(index, deps)) return
		slots[index] = [deps]
		effect()
	}
}))

function changed(index: number, deps: unknown[]) {
	const previous = (slots[index] as [unknown[]] | undefined)?.[0]
	return !previous?.every((dep, i) => Object.is(dep, deps[i]))
}

const { createPushNotifications, usePushNotifications } = await import('./push')

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function setup(overrides: Record<string, unknown> = {}) {
	const store = new Map<string, string>()
	const registered: (string | null)[] = []
	const unavailable: string[] = []
	const errors: string[] = []
	const push = createPushNotifications({
		storage: {
			getItem: async (key) => store.get(key) ?? null,
			setItem: async (key, value) => {
				store.set(key, value)
			}
		},
		registerDevice: async (token) => {
			registered.push(token)
		},
		onUnavailable: (reason) => unavailable.push(reason),
		onError: (message) => errors.push(message),
		...overrides
	})
	return { push, store, registered, unavailable, errors }
}

beforeEach(() => {
	calls.length = 0
	removed.length = 0
	granted = false
	requestGrants = true
	launchResponse = null
	tokenError = null
	token = 'ExponentPushToken[abc]'
	rotateToken = undefined
	slots.length = 0
	mockDevice(true)
})

describe('createPushNotifications', () => {
	test('configures the foreground handler and the Android channel', async () => {
		setup()
		const handler = notifications.setNotificationHandler.mock.lastCall?.[0]
		expect(await handler.handleNotification()).toMatchObject({
			shouldShowBanner: true,
			shouldSetBadge: false
		})
		expect(notifications.setNotificationChannelAsync).toHaveBeenCalledWith(
			'default',
			expect.objectContaining({ name: 'Default', importance: 4 })
		)
	})

	test('prompt asks once, then registers the token', async () => {
		const confirm = mock(async () => true)
		const { push, registered } = setup({ confirm })

		expect(await push.prompt()).toBe(true)
		expect(confirm).toHaveBeenCalledTimes(1)
		expect(registered).toEqual(['ExponentPushToken[abc]'])

		expect(await push.prompt()).toBe(false)
		expect(confirm).toHaveBeenCalledTimes(1)
		expect(calls).toEqual(['request'])
	})

	test('concurrent prompts share one dialog', async () => {
		const confirm = mock(async () => true)
		const { push } = setup({ confirm })

		const results = await Promise.all([push.prompt(), push.prompt()])
		expect(results).toEqual([true, true])
		expect(confirm).toHaveBeenCalledTimes(1)
		expect(calls).toEqual(['request'])
	})

	test('a declined soft-ask skips the OS dialog but still counts as asked', async () => {
		const { push, registered } = setup({ confirm: async () => false })

		expect(await push.prompt()).toBe(false)
		expect(calls).toEqual([])
		expect(registered).toEqual([])
		expect(await push.hasPrompted()).toBe(true)
	})

	test('a denied OS dialog reports it and registers nothing', async () => {
		requestGrants = false
		const { push, registered, unavailable } = setup()

		expect(await push.prompt()).toBe(false)
		expect(unavailable).toEqual(['denied'])
		expect(registered).toEqual([])
	})

	test('a simulator never shows the OS dialog', async () => {
		mockDevice(false)
		const { push, unavailable } = setup()

		expect(await push.enable()).toBe(false)
		expect(unavailable).toEqual(['not-a-device'])
		expect(calls).toEqual([])
		expect(await push.getPushToken()).toBeNull()
	})

	test('a failing storage read prompts rather than throwing', async () => {
		const { push } = setup({
			storage: {
				getItem: async () => {
					throw new Error('disk')
				},
				setItem: async () => {}
			}
		})
		expect(await push.prompt()).toBe(true)
	})

	test('syncToken registers only while permission is granted', async () => {
		const { push, registered } = setup()
		expect(await push.syncToken()).toBe(false)

		granted = true
		expect(await push.syncToken()).toBe(true)
		expect(registered).toEqual(['ExponentPushToken[abc]'])
	})

	test('token failures are reported, not thrown', async () => {
		granted = true
		tokenError = new Error('no projectId')
		const { push, registered, errors } = setup()

		expect(await push.syncToken()).toBe(false)
		expect(registered).toEqual([])
		expect(errors).toEqual(['Failed to get the Expo push token'])
	})

	test('disable unregisters the device', async () => {
		const { push, registered } = setup()
		await push.disable()
		expect(registered).toEqual([null])
	})

	test('listen re-registers a token that changed since it was sent', async () => {
		granted = true
		const { push, registered, store } = setup()
		await push.syncToken()

		push.listen()
		await flush()
		expect(registered).toEqual(['ExponentPushToken[abc]'])

		token = 'ExponentPushToken[new]'
		rotateToken?.({ type: 'ios', data: 'apns' })
		await flush()
		expect(registered).toEqual([
			'ExponentPushToken[abc]',
			'ExponentPushToken[new]'
		])
		expect(store.get('@notifications_push_token')).toBe(
			'ExponentPushToken[new]'
		)
	})

	test('listen registers nothing until push was turned on, or after disable', async () => {
		granted = true
		const { push, registered } = setup()
		push.listen()
		await flush()
		expect(registered).toEqual([])

		await push.syncToken()
		await push.disable()
		token = 'ExponentPushToken[new]'
		push.listen()
		await flush()
		expect(registered).toEqual(['ExponentPushToken[abc]', null])
	})

	test('listen replays the launch response and unsubscribes', () => {
		launchResponse = { notification: { id: 'launch' } }
		const { push } = setup()
		const onResponse = mock()

		const unsubscribe = push.listen({ onReceived: () => {}, onResponse })
		expect(onResponse).toHaveBeenCalledWith(launchResponse)

		unsubscribe()
		expect(removed).toEqual(['token', 'received', 'response'])
	})
})

describe('usePushNotifications', () => {
	function useRender(
		push: ReturnType<typeof setup>['push'],
		options: Parameters<typeof usePushNotifications>[1]
	) {
		slot = 0
		return usePushNotifications(push, options)
	}

	test('enable and disable save the preference first', async () => {
		const { push, registered } = setup()
		const saved: boolean[] = []
		const persist = async (enabled: boolean) => {
			saved.push(enabled)
		}

		expect(await useRender(push, { persist }).enable()).toBe(true)
		expect(useRender(push, { persist }).isEnabled).toBe(true)

		await useRender(push, { persist }).disable()
		expect(useRender(push, { persist }).isEnabled).toBe(false)
		expect(saved).toEqual([true, false])
		expect(registered).toEqual(['ExponentPushToken[abc]', null])
	})

	test('a failing persist rolls back and rethrows without touching push', async () => {
		const { push, registered } = setup()
		const persist = async () => {
			throw new Error('offline')
		}

		await expect(useRender(push, { persist }).enable()).rejects.toThrow(
			'offline'
		)
		expect(calls).toEqual([])
		expect(registered).toEqual([])
		granted = true
		await useRender(push, { persist }).refresh()
		expect(useRender(push, { persist }).isEnabled).toBe(false)
	})
})
