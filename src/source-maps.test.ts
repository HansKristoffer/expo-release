import { describe, expect, test } from 'bun:test'
import {
	assertSourceMaps,
	expoCommand,
	mergeUpdateArgs,
	sourceMapExportCommand,
	sourceMapUpdateArgs
} from './source-maps'

describe('expoCommand', () => {
	test('defaults to bunx expo', () => {
		const previous = process.env.EXPO_BIN
		delete process.env.EXPO_BIN
		try {
			expect(expoCommand('export')).toEqual(['bunx', 'expo', 'export'])
		} finally {
			if (previous === undefined) {
				delete process.env.EXPO_BIN
			} else {
				process.env.EXPO_BIN = previous
			}
		}
	})

	test('honors EXPO_BIN', () => {
		const previous = process.env.EXPO_BIN
		process.env.EXPO_BIN = '/tmp/expo'
		try {
			expect(expoCommand('export')).toEqual(['/tmp/expo', 'export'])
		} finally {
			if (previous === undefined) {
				delete process.env.EXPO_BIN
			} else {
				process.env.EXPO_BIN = previous
			}
		}
	})
})

describe('sourceMapExportCommand', () => {
	test('exports external maps for the release platform', () => {
		const previous = process.env.EXPO_BIN
		delete process.env.EXPO_BIN
		try {
			expect(sourceMapExportCommand('ios')).toEqual([
				'bunx',
				'expo',
				'export',
				'--platform',
				'ios',
				'--output-dir',
				'dist',
				'--source-maps',
				'external'
			])
		} finally {
			if (previous === undefined) {
				delete process.env.EXPO_BIN
			} else {
				process.env.EXPO_BIN = previous
			}
		}
	})
})

describe('mergeUpdateArgs', () => {
	test('leaves extra args alone when export is off', () => {
		expect(mergeUpdateArgs(['--private-key-path', 'key'], false)).toEqual([
			'--private-key-path',
			'key'
		])
	})

	test('appends input-dir and skip-bundler when export is on', () => {
		expect(mergeUpdateArgs(undefined, true)).toEqual(sourceMapUpdateArgs())
	})

	test('does not duplicate existing bundler args', () => {
		expect(
			mergeUpdateArgs(['--input-dir', 'dist', '--skip-bundler'], true)
		).toEqual(['--input-dir', 'dist', '--skip-bundler'])
	})
})

describe('assertSourceMaps', () => {
	test('passes when a map exists', async () => {
		await assertSourceMaps(async () => true)
	})

	test('fails when export produced no maps', async () => {
		await expect(assertSourceMaps(async () => false)).rejects.toThrow(
			'Hermes source maps'
		)
	})
})
