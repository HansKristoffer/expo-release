export function parseFlagArgs(
	args: string[],
	usage: string
): Map<string, string> {
	const values = new Map<string, string>()
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index]
		const value = args[index + 1]
		if (!key?.startsWith('--') || !value) {
			throw new Error(usage)
		}
		values.set(key.slice(2), value)
	}
	return values
}

export function parseImpactPaths(value: string | undefined): string[] {
	const paths = (value ?? DEFAULT_IMPACT_PATHS.join(','))
		.split(',')
		.map((path) => path.trim())
		.filter(Boolean)
	if (paths.length === 0) {
		throw new Error('At least one --impact-paths entry is required')
	}
	return paths
}

export function parsePlatform(value: string | undefined): ReleasePlatform {
	if (value === undefined || value === 'ios') return 'ios'
	if (value === 'android') return 'android'
	throw new Error('Usage: --platform ios|android')
}

export function parseBoolean(value: string | undefined, fallback: boolean) {
	if (value === undefined) return fallback
	if (value === 'true') return true
	if (value === 'false') return false
	throw new Error(`Expected true or false, received: ${value}`)
}

export const DEFAULT_IMPACT_PATHS = ['apps/expo/'] as const

export type ReleasePlatform = 'ios' | 'android'
