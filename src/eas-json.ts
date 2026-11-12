import type { ReleasePlatform } from './args'

/** The fields of an eas.json build profile that expo-release reads. */
export type BuildProfile = {
	channel?: string
	environment?: string
	env?: Record<string, string>
	node?: string
	bun?: string
}

export type EasJson = {
	cli?: { version?: string }
	build?: Record<string, Record<string, unknown>>
	submit?: Record<string, unknown>
}

/** Reads eas.json from the working directory. eas-cli accepts JSON5 there. */
export async function readEasJson(path = 'eas.json'): Promise<EasJson | null> {
	const file = Bun.file(path)
	if (!(await file.exists())) return null
	const value = Bun.JSON5.parse(await file.text())
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error(`${path} must hold an object`)
	}
	return value as EasJson
}

type RawProfile = Record<string, unknown>

function asRecord(value: unknown): RawProfile | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as RawProfile)
		: undefined
}

// The merge eas-cli applies (@expo/eas-json build/resolver): later keys win,
// `env` and the platform blocks merge one level deep.
function merge(base: RawProfile, update: RawProfile): RawProfile {
	const result = { ...base, ...update }
	for (const key of ['env', 'ios', 'android']) {
		const a = asRecord(base[key])
		const b = asRecord(update[key])
		if (a && b) result[key] = key === 'env' ? { ...a, ...b } : merge(a, b)
	}
	return result
}

function resolveRaw(
	easJson: EasJson,
	name: string,
	depth: number
): RawProfile | null {
	if (depth >= 5) {
		throw new Error(
			'eas.json: too long a chain of "extends"; check the build profiles for a cycle'
		)
	}
	const profile = asRecord(easJson.build?.[name])
	if (!profile) {
		if (depth === 0) return null
		throw new Error(`eas.json: build profile extends missing "${name}"`)
	}
	const { extends: parent, ...rest } = profile
	return typeof parent === 'string'
		? merge(resolveRaw(easJson, parent, depth + 1) ?? {}, rest)
		: rest
}

/** `build.<name>` with `extends` and the platform block applied, or null. */
export function resolveBuildProfile(
	easJson: EasJson,
	name: string,
	platform: ReleasePlatform
): BuildProfile | null {
	const raw = resolveRaw(easJson, name, 0)
	if (!raw) return null
	const { ios, android, ...base } = raw
	const resolved = merge(
		base,
		asRecord(platform === 'ios' ? ios : android) ?? {}
	)
	const text = (key: string) =>
		typeof resolved[key] === 'string' && resolved[key] !== ''
			? (resolved[key] as string)
			: undefined
	const env = asRecord(resolved.env)
	return {
		channel: text('channel'),
		environment: text('environment'),
		node: text('node'),
		bun: text('bun'),
		...(env
			? {
					env: Object.fromEntries(
						Object.entries(env).map(([key, value]) => [key, String(value)])
					)
				}
			: {})
	}
}

/**
 * Puts the profile's `env` into this process, so every EAS command and hook
 * sees what the EAS build machine sees. Variables already set win.
 */
export function applyProfileEnv(
	profile: BuildProfile | null,
	env: Record<string, string | undefined> = process.env
): string[] {
	const applied: string[] = []
	for (const [key, value] of Object.entries(profile?.env ?? {})) {
		if (env[key] !== undefined) continue
		env[key] = value
		applied.push(key)
	}
	return applied
}
