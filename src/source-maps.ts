import { exists } from 'node:fs/promises'
import type { ReleasePlatform } from './args'

export const SOURCE_MAP_OUTPUT_DIR = 'dist'

export function expoCommand(...args: string[]): string[] {
	const bin = process.env.EXPO_BIN?.trim()
	if (bin && bin.length > 0) return [bin, ...args]
	return ['bunx', 'expo', ...args]
}

export function sourceMapExportCommand(platform: ReleasePlatform): string[] {
	return expoCommand(
		'export',
		'--platform',
		platform,
		'--output-dir',
		SOURCE_MAP_OUTPUT_DIR,
		'--source-maps',
		'external'
	)
}

export function sourceMapUpdateArgs(): string[] {
	return ['--input-dir', SOURCE_MAP_OUTPUT_DIR, '--skip-bundler']
}

export function mergeUpdateArgs(
	extra: string[] | undefined,
	exportSourceMaps: boolean
): string[] {
	const args = extra ? [...extra] : []
	if (!exportSourceMaps) return args
	if (!args.includes('--input-dir')) {
		args.push('--input-dir', SOURCE_MAP_OUTPUT_DIR)
	}
	if (!args.includes('--skip-bundler')) {
		args.push('--skip-bundler')
	}
	return args
}

export async function defaultHasSourceMaps(
	directory = SOURCE_MAP_OUTPUT_DIR
): Promise<boolean> {
	if (!(await exists(directory))) return false

	for await (const _ of new Bun.Glob('**/*.map').scan(directory)) {
		return true
	}
	return false
}

export async function assertSourceMaps(
	hasSourceMaps: () => Promise<boolean> = defaultHasSourceMaps
) {
	if (await hasSourceMaps()) return
	throw new Error(
		'Expo export did not produce Hermes source maps in dist; refusing to publish an OTA update.'
	)
}
