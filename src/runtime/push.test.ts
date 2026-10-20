import { beforeEach, describe, expect, mock, test } from 'bun:test'

const calls: string[] = []
let granted = false
let requestGrants = true
let launchResponse: unknown = null
let tokenError: Error | null = null
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
		return { data: 'ExponentPushToken[abc]' }
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

const { createPushNotifications } = await import('./push')

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

	test('listen replays the launch response and unsubscribes', () => {
		launchResponse = { notification: { id: 'launch' } }
		const { push } = setup()
		const onResponse = mock()

		const unsubscribe = push.listen({ onReceived: () => {}, onResponse })
		expect(onResponse).toHaveBeenCalledWith(launchResponse)

		unsubscribe()
		expect(removed).toEqual(['received', 'response'])
	})
})
