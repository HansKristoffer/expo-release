import * as Updates from 'expo-updates'
import { useEffect, useRef } from 'react'
import { AppState } from 'react-native'

declare const __DEV__: boolean | undefined

/** Restarts the app on the downloaded update. */
export type ReloadApp = () => Promise<void>

/** Which release is running, for crash reports and a version screen. */
export interface ReleaseInfo {
	/** The running EAS update; null for the build's embedded bundle and in Expo Go. */
	updateId: string | null
	runtimeVersion: string | null
	channel: string | null
	/** When the running update (or the embedded bundle) was published. */
	createdAt: Date | null
	isEmbeddedLaunch: boolean
}

/** The running release, read from expo-updates. Safe in Expo Go and development. */
export function getReleaseInfo(): ReleaseInfo {
	return {
		updateId: Updates.updateId ?? null,
		runtimeVersion: Updates.runtimeVersion ?? null,
		channel: Updates.channel ?? null,
		createdAt: Updates.createdAt ?? null,
		isEmbeddedLaunch: Updates.isEmbeddedLaunch === true
	}
}

/** Downloads an available update; resolves its id (or '') when it is new. */
async function downloadUpdate(): Promise<string | null> {
	const update = await Updates.checkForUpdateAsync()
	if (!update.isAvailable) return null
	const result = await Updates.fetchUpdateAsync()
	if (!result.isNew) return null
	const id = (result.manifest as { id?: unknown } | undefined)?.id
	return typeof id === 'string' ? id : ''
}

/**
 * Checks for an EAS update and downloads it. Calls `onUpdateReady` once a new
 * update is on disk; show a "Restart" prompt there and call `reload` to apply.
 * Returns whether a new update was downloaded.
 */
export async function checkForOTAUpdate(
	onUpdateReady: (reload: ReloadApp) => void
): Promise<boolean> {
	if ((await downloadUpdate()) === null) return false
	onUpdateReady(() => Updates.reloadAsync())
	return true
}

export interface UseOTAUpdatesOptions {
	/** Defaults to off in development and wherever expo-updates is disabled (Expo Go). */
	enabled?: boolean
	/**
	 * Check again when the app returns to the foreground, at most once per this
	 * many minutes. Off by default: an app kept open for days then gets a fix
	 * only after the OS kills it.
	 */
	recheckOnForeground?: number
	/** A failed check is retried on the next launch or foreground. Defaults to console.warn. */
	onError?: (error: unknown) => void
}

/**
 * Checks for an update once per mount, and on foreground with
 * `recheckOnForeground`. `onUpdateReady` runs once per downloaded update. The
 * callbacks are read through refs, so an unstable toast function never re-runs
 * the check or stacks prompts.
 */
export function useOTAUpdates(
	onUpdateReady: (reload: ReloadApp) => void,
	options: UseOTAUpdatesOptions = {}
): void {
	const {
		enabled = Updates.isEnabled && !(typeof __DEV__ !== 'undefined' && __DEV__),
		recheckOnForeground
	} = options
	const callbacks = useRef({ onUpdateReady, onError: options.onError })
	callbacks.current = { onUpdateReady, onError: options.onError }
	const state = useRef({
		checked: false,
		running: false,
		lastCheck: 0,
		readyId: null as string | null
	})

	useEffect(() => {
		if (!enabled) return
		const check = () => {
			const current = state.current
			if (current.running) return
			current.running = true
			current.lastCheck = Date.now()
			downloadUpdate()
				.then((id) => {
					// '' (no manifest id) always counts as a new update.
					if (id === null || (id !== '' && id === current.readyId)) return
					current.readyId = id
					callbacks.current.onUpdateReady(() => Updates.reloadAsync())
				})
				.catch((error: unknown) =>
					(
						callbacks.current.onError ??
						((e: unknown) => console.warn('OTA update check failed', e))
					)(error)
				)
				.finally(() => {
					current.running = false
				})
		}

		if (!state.current.checked) {
			state.current.checked = true
			check()
		}
		if (recheckOnForeground === undefined) return
		const subscription = AppState.addEventListener('change', (next) => {
			if (
				next === 'active' &&
				Date.now() - state.current.lastCheck >= recheckOnForeground * 60_000
			) {
				check()
			}
		})
		return () => subscription.remove()
	}, [enabled, recheckOnForeground])
}
