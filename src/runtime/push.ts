import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { useCallback, useEffect, useState } from 'react'

/** Async key-value store. AsyncStorage and expo-secure-store adapters fit. */
export interface KeyValueStorage {
	getItem(key: string): Promise<string | null>
	setItem(key: string, value: string): Promise<void>
}

export interface PushNotificationsOptions {
	/** Remembers that the one-time prompt ran. */
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
		storageKey = '@notifications_permission_asked'
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

	async function hasPrompted() {
		try {
			return (await storage.getItem(storageKey)) === 'true'
		} catch {
			return false
		}
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

	async function getPushToken() {
		if (!Device.isDevice) return null
		try {
			const token = await Notifications.getExpoPushTokenAsync(
				projectId ? { projectId } : undefined
			)
			return token.data
		} catch (error) {
			onError('Failed to get the Expo push token', error)
			return null
		}
	}

	/** Registers the current token. Resolves whether one was registered. */
	async function syncToken() {
		if (!(await getPermissionStatus()).granted) return false
		const token = await getPushToken()
		if (!token) return false
		try {
			await registerDevice(token)
			return true
		} catch (error) {
			onError('Failed to register the push token', error)
			return false
		}
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
		disable() {
			return registerDevice(null)
		},

		/** Subscribes to notifications. Returns the unsubscribe function. */
		listen({ onReceived, onResponse }: NotificationListeners) {
			const subscriptions = [
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

/**
 * Push state for a settings screen. `enabled` is the user's saved preference;
 * while it is on, the token is re-registered on mount.
 */
export function usePushNotifications(
	push: PushNotifications,
	{ enabled = false }: { enabled?: boolean } = {}
) {
	const [permission, setPermission] =
		useState<Notifications.NotificationPermissionsStatus | null>(null)
	const [isLoading, setIsLoading] = useState(false)

	const refresh = useCallback(async () => {
		setPermission(await push.getPermissionStatus())
	}, [push])

	useEffect(() => {
		void refresh()
		if (enabled) void push.syncToken()
	}, [push, enabled, refresh])

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
		isEnabled: enabled && permission?.granted === true,
		isLoading,
		prompt: withLoading(push.prompt),
		enable: withLoading(push.enable),
		disable: withLoading(push.disable),
		refresh
	}
}
