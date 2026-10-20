import * as Updates from 'expo-updates'
import { useEffect, useRef } from 'react'

declare const __DEV__: boolean | undefined

/** Restarts the app on the downloaded update. */
export type ReloadApp = () => Promise<void>

/**
 * Checks for an EAS update and downloads it. Calls `onUpdateReady` once a new
 * update is on disk; show a "Restart" prompt there and call `reload` to apply.
 * Returns whether a new update was downloaded.
 */
export async function checkForOTAUpdate(
	onUpdateReady: (reload: ReloadApp) => void
): Promise<boolean> {
	const update = await Updates.checkForUpdateAsync()
	if (!update.isAvailable) return false
	const result = await Updates.fetchUpdateAsync()
	if (!result.isNew) return false
	onUpdateReady(() => Updates.reloadAsync())
	return true
}

export interface UseOTAUpdatesOptions {
	/** Defaults to off in development and wherever expo-updates is disabled (Expo Go). */
	enabled?: boolean
	/** A failed check is retried on the next launch; defaults to ignoring it. */
	onError?: (error: unknown) => void
}

/**
 * Checks for an update once per mount. The callbacks are read through refs, so
 * an unstable toast function never re-runs the check or stacks prompts.
 */
export function useOTAUpdates(
	onUpdateReady: (reload: ReloadApp) => void,
	options: UseOTAUpdatesOptions = {}
): void {
	const {
		enabled = Updates.isEnabled && !(typeof __DEV__ !== 'undefined' && __DEV__)
	} = options
	const callbacks = useRef({ onUpdateReady, onError: options.onError })
	callbacks.current = { onUpdateReady, onError: options.onError }
	const checked = useRef(false)

	useEffect(() => {
		if (!enabled || checked.current) return
		checked.current = true
		checkForOTAUpdate((reload) =>
			callbacks.current.onUpdateReady(reload)
		).catch((error: unknown) => callbacks.current.onError?.(error))
	}, [enabled])
}
