import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { useCallback, useEffect, useState } from 'react'

/** Async key-value store. AsyncStorage and expo-secure-store adapters fit. */
export interface KeyValueStorage {
	getItem(key: string): Promise<string | null>
	setItem(key: string, value: string): Promise<void>
}

export interface PushNotificationsOptions {
	/** Remembers that the one-time prompt ran and the last token sent. */
	storage: KeyValueStorage
	/** Saves this device's Expo push token on your backend; `null` removes it. */
	registerDevice: (token: string | null) => Promise<void>
	/**
	 * Explains push before the OS dialog. Resolve `true` to continue. Without
	 * it, `prompt()` goes straight to the OS dialog.
	 */
	confirm?: () => Promise<boolean>
	/** Push is off: the app runs on a simulator or the user denied permission. */
	onUnavailable?: (reason: 'not-a-device' | 'denied') => void
	onError?: (message: string, error: unknown) => void
	/** Defaults to what expo-notifications reads from the app config. */
	projectId?: string
	/** Android channel `default`, needed for heads-up notifications. */
	androidChannel?: Notifications.NotificationChannelInput
	/** How notifications show while the app is in the foreground. */
	foregroundBehavior?: Notifications.NotificationBehavior
	storageKey?: string
	/** Holds the last token passed to `registerDevice`. */
	tokenStorageKey?: string
}

export interface NotificationListeners {
	onReceived?: (notification: Notifications.Notification) => void
	/** Also called with the response that launched the app, if any. */
	onResponse?: (response: Notifications.NotificationResponse) => void
}

export type PushNotifications = ReturnType<typeof createPushNotifications>

/**
 * expo-notifications behind one object: permission flow, Expo push token and
 * device registration. Create it once at module level.
 */
export function createPushNotifications(options: PushNotificationsOptions) {
	const {
		storage,
		registerDevice,
		confirm,
		onUnavailable,
		onError = (message, error) => console.error(message, error),
		projectId,
		storageKey = '@notifications_permission_asked',
		tokenStorageKey = '@notifications_push_token'
	} = options

	Notifications.setNotificationHandler({
		handleNotification: async () =>
			options.foregroundBehavior ?? {
				shouldShowBanner: true,
				shouldShowList: true,
				shouldPlaySound: true,
				shouldSetBadge: false
			}
	})
	// Channels exist only on Android; elsewhere this resolves to null.
	Notifications.setNotificationChannelAsync(
		'default',
		options.androidChannel ?? {
			name: 'Default',
			importance: Notifications.AndroidImportance.HIGH,
			vibrationPattern: [0, 250, 250, 250]
		}
	).catch((error: unknown) =>
		onError('Failed to create the notification channel', error)
	)

	let pendingPrompt: Promise<boolean> | null = null

	const getPermissionStatus = () => Notifications.getPermissionsAsync()

	async function read(key: string) {
		try {
			return await storage.getItem(key)
		} catch {
			return null
		}
	}

	async function rememberToken(token: string) {
		try {
			await storage.setItem(tokenStorageKey, token)
		} catch (error) {
			onError('Failed to remember the push token', error)
		}
	}

	async function hasPrompted() {
		return (await read(storageKey)) === 'true'
	}

	/** Shows the OS dialog when it still can. Resolves whether push is allowed. */
	async function requestPermissions() {
		if (!Device.isDevice) {
			onUnavailable?.('not-a-device')
			return false
		}
		try {
			const { granted } = await Notifications.requestPermissionsAsync()
			if (!granted) onUnavailable?.('denied')
			return granted
		} catch (error) {
			onError('Failed to request notification permissions', error)
			return false
		}
	}

	async function getPushToken(devicePushToken?: Notifications.DevicePushToken) {
		if (!Device.isDevice) return null
		try {
			const token = await Notifications.getExpoPushTokenAsync(
				projectId || devicePushToken
					? { projectId, devicePushToken }
					: undefined
			)
			return token.data
		} catch (error) {
			onError('Failed to get the Expo push token', error)
			return null
		}
	}

	async function sendToken(token: string) {
		try {
			await registerDevice(token)
		} catch (error) {
			onError('Failed to register the push token', error)
			return false
		}
		await rememberToken(token)
		return true
	}

	/** Registers the current token. Resolves whether one was registered. */
	async function syncToken() {
		if (!(await getPermissionStatus()).granted) return false
		const token = await getPushToken()
		return token ? sendToken(token) : false
	}

	/**
	 * Re-registers a token that changed since it was last sent. Runs only while
	 * push is on for this device: a token was sent and `disable()` has not run.
	 */
	async function refreshToken(devicePushToken?: Notifications.DevicePushToken) {
		const sent = await read(tokenStorageKey)
		if (!sent || !(await getPermissionStatus()).granted) return
		const token = await getPushToken(devicePushToken)
		if (token && token !== sent) await sendToken(token)
	}

	async function runPrompt() {
		if (await hasPrompted()) return false
		// Mark first so a crash or a second caller never shows the dialog twice.
		try {
			await storage.setItem(storageKey, 'true')
		} catch (error) {
			onError('Failed to remember the notification prompt', error)
		}
		if (confirm && !(await confirm())) return false
		if (!(await requestPermissions())) return false
		await syncToken()
		return true
	}

	return {
		getPermissionStatus,
		hasPrompted,
		requestPermissions,
		getPushToken,
		syncToken,

		/**
		 * Asks for push once per install (after sign-in, say), then registers the
		 * token. Never throws; concurrent calls share one dialog.
		 */
		prompt(): Promise<boolean> {
			pendingPrompt ??= runPrompt()
				.catch((error: unknown) => {
					onError('Failed to prompt for notifications', error)
					return false
				})
				.finally(() => {
					pendingPrompt = null
				})
			return pendingPrompt
		},

		/** Turns push on from settings. Resolves whether it is on. */
		async enable() {
			if (!(await requestPermissions())) return false
			await syncToken()
			return true
		},

		/** Removes this device's token from your backend. */
		async disable() {
			await registerDevice(null)
			// KeyValueStorage has no removeItem; an empty token means none was sent.
			await rememberToken('')
		},

		/**
		 * Subscribes to notifications and keeps the registered token current: on
		 * start and whenever Expo rotates it. Returns the unsubscribe function.
		 */
		listen({ onReceived, onResponse }: NotificationListeners = {}) {
			const refresh = (devicePushToken?: Notifications.DevicePushToken) =>
				refreshToken(devicePushToken).catch((error: unknown) =>
					onError('Failed to refresh the push token', error)
				)
			void refresh()
			const subscriptions = [
				Notifications.addPushTokenListener(refresh),
				onReceived && Notifications.addNotificationReceivedListener(onReceived),
				onResponse &&
					Notifications.addNotificationResponseReceivedListener(onResponse)
			]
			const launchResponse = onResponse
				? Notifications.getLastNotificationResponse()
				: null
			if (launchResponse) onResponse?.(launchResponse)
			return () => {
				for (const subscription of subscriptions) subscription?.remove()
			}
		}
	}
}

export interface UsePushNotificationsOptions {
	/** The user's saved preference, for example from your API. */
	enabled?: boolean
	/**
	 * Saves the preference. `enable()` and `disable()` call it first and show
	 * the new value at once; when it rejects, they roll back and rethrow.
	 */
	persist?: (enabled: boolean) => Promise<unknown>
}

/**
 * Push state for a settings screen. `enabled` is the user's saved preference;
 * while it is on, the token is re-registered on mount.
 */
export function usePushNotifications(
	push: PushNotifications,
	{ enabled = false, persist }: UsePushNotificationsOptions = {}
) {
	const [permission, setPermission] =
		useState<Notifications.NotificationPermissionsStatus | null>(null)
	const [isLoading, setIsLoading] = useState(false)
	// Set by enable/disable until `enabled` catches up with the saved value.
	const [optimistic, setOptimistic] = useState<boolean | null>(null)
	const preference = optimistic ?? enabled

	const refresh = useCallback(async () => {
		setPermission(await push.getPermissionStatus())
	}, [push])

	useEffect(() => {
		setOptimistic(null)
		void refresh()
		if (enabled) void push.syncToken()
	}, [push, enabled, refresh])

	const save = useCallback(
		async (next: boolean) => {
			if (!persist) return
			setOptimistic(next)
			try {
				await persist(next)
			} catch (error) {
				setOptimistic(null)
				throw error
			}
		},
		[persist]
	)

	const withLoading = useCallback(
		<T>(action: () => Promise<T>) =>
			async () => {
				setIsLoading(true)
				try {
					return await action()
				} finally {
					await refresh()
					setIsLoading(false)
				}
			},
		[refresh]
	)

	return {
		permission,
		isEnabled: preference && permission?.granted === true,
		isLoading,
		prompt: withLoading(push.prompt),
		enable: withLoading(async () => {
			await save(true)
			return push.enable()
		}),
		disable: withLoading(async () => {
			await save(false)
			await push.disable()
		}),
		refresh
	}
}
