import { describe, expect, test } from 'bun:test'
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cliPath = join(import.meta.dir, 'cli.ts')

// Runs the bin like the composite action does: `bun src/cli.ts` with only the given env.
function run(
	argv: string[],
	env: Record<string, string> = {},
	files: Record<string, string> = {}
) {
	const dir = mkdtempSync(join(tmpdir(), 'expo-release-cli-'))
	const outputPath = join(dir, 'github-output')
	const app = join(dir, 'app')
	mkdirSync(app)
	for (const [name, text] of Object.entries(files)) {
		writeFileSync(join(app, name), text, { mode: 0o755 })
	}
	try {
		const child = Bun.spawnSync(['bun', cliPath, ...argv], {
			cwd: Object.keys(files).length > 0 ? app : undefined,
			env: {
				PATH: process.env.PATH ?? '',
				HOME: process.env.HOME ?? '',
				GITHUB_OUTPUT: outputPath,
				...env
			}
		})
		const output = (() => {
			try {
				return readFileSync(outputPath, 'utf8').replace(/EOF_\w+/g, 'EOF')
			} catch {
				return ''
			}
		})()
		return {
			exitCode: child.exitCode,
			stdout: child.stdout.toString(),
			stderr: child.stderr.toString(),
			output
		}
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

const noDeploy =
	'{"deployType":"none","reason":"no-impact-path","nativeBuildPending":false,"changedFiles":[],"fingerprint":null,"build":null}\n'
const diff = ['--profile', 'production', '--base', 'HEAD', '--head', 'HEAD']

describe('help', () => {
	test('prints root help with no arguments', () => {
		const result = run([])
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toBe(run(['--help']).stdout)
		expect(result.stdout).toMatchSnapshot()
	})

	for (const command of ['release', 'decide', 'operate']) {
		test(command, () => {
			const result = run([command, '--help'])
			expect(result.exitCode).toBe(0)
			expect(result.stdout).toMatchSnapshot()
		})
	}
})

describe('runs', () => {
	test('decide prints the decision and writes its outputs', () => {
		const result = run(['decide', ...diff])
		expect(result).toMatchObject({ exitCode: 0, stdout: noDeploy })
		expect(result.output).toMatchSnapshot()
	})

	test('operate prints the result and writes it', () => {
		const result = run(['--profile', 'production', 'operate'])
		expect(result).toMatchObject({ exitCode: 0, stdout: 'skipped\n' })
		expect(result.output).toStartWith('result<<EOF\nskipped\nEOF\n')
	})

	test('release decides, then operates', () => {
		const result = run(['release', ...diff])
		expect(result).toMatchObject({
			exitCode: 0,
			stdout: `${noDeploy}skipped\n`
		})
	})

	test('the action passes everything through env, empty inputs as unset', () => {
		const result = run([], {
			EXPO_RELEASE_COMMAND: 'release',
			EXPO_RELEASE_PROFILE: 'production',
			EXPO_RELEASE_BASE: '',
			EXPO_RELEASE_HEAD: '',
			EXPO_RELEASE_CHANNEL: '',
			EXPO_RELEASE_GROUP: '',
			EXPO_RELEASE_IMPACT_PATHS: 'apps/expo/',
			EXPO_RELEASE_AUTO_SUBMIT: 'true',
			EXPO_RELEASE_DRY_RUN: 'false',
			GITHUB_EVENT_BEFORE: 'HEAD',
			GITHUB_SHA: 'HEAD'
		})
		expect(result).toMatchObject({
			exitCode: 0,
			stdout: `${noDeploy}skipped\n`
		})
	})

	test('the action trims padded inputs, as from a YAML block scalar', () => {
		const result = run([], {
			EXPO_RELEASE_COMMAND: ' operate\n',
			EXPO_RELEASE_PROFILE: 'production',
			EXPO_RELEASE_PLATFORM: ' android\n',
			EXPO_RELEASE_DEPLOY_TYPE: 'native\n',
			EXPO_RELEASE_AUTO_SUBMIT: 'false\n',
			EXPO_RELEASE_DRY_RUN: ' true\n'
		})
		expect(result).toMatchObject({ exitCode: 0, stdout: 'native-build\n' })
		expect(result.stderr).toStartWith(
			'[dry-run] eas build --platform android --profile production --non-interactive --no-wait --json\n'
		)
	})

	test('operate --dry-run prints the EAS command it would run', () => {
		const result = run([
			'operate',
			'--profile',
			'production',
			'--deploy-type',
			'native',
			'--auto-submit',
			'false',
			'--dry-run'
		])
		expect(result).toMatchObject({ exitCode: 0, stdout: 'native-build\n' })
		expect(result.stderr).toStartWith(
			'[dry-run] eas build --platform ios --profile production --non-interactive --no-wait --json\n'
		)
	})

	test('channel, environment and env come from the eas.json build profile', () => {
		const easJson = JSON.stringify({
			build: {
				production: {
					channel: 'live',
					environment: 'production',
					env: { APP_VARIANT: 'production' }
				}
			}
		})
		const result = run(
			[
				'operate',
				'--profile',
				'production',
				'--deploy-type',
				'ota',
				'--dry-run'
			],
			{},
			{ 'eas.json': easJson }
		)
		expect(result.exitCode).toBe(0)
		expect(result.stderr).toContain(
			'env from eas.json build.production: APP_VARIANT'
		)
		expect(result.stderr).toContain(
			'[dry-run] eas update --channel live --platform ios'
		)
		expect(result.stderr).toContain('--environment production')
	})

	test('a failed EAS command reports its stage without a stack trace', () => {
		const eas =
			'#!/bin/sh\necho "Credentials are not set up. Run this command again in interactive mode." >&2\nexit 1\n'
		const result = run(
			['operate', '--profile', 'production', '--deploy-type', 'native'],
			{ GITHUB_ACTIONS: 'true', EAS_BIN: './eas' },
			{ eas, 'eas.json': '{"build":{"production":{}}}' }
		)
		expect(result.exitCode).toBe(1)
		expect(result.stderr).toContain(
			'::error title=expo-release%3A native build failed (production%2C ios)::Credentials are not set up.'
		)
		expect(result.stderr).not.toContain('    at ')
		expect(result.output).toContain('result<<EOF\nfailed\nEOF')
		expect(result.output).toContain('failed_stage<<EOF\nnative build\nEOF')
		expect(result.output).toContain(
			'eas credentials:configure-build --platform ios --profile production'
		)
	})

	test('bad arguments exit 1', () => {
		expect(
			run(['operate', '--profile', 'production', '--operation', 'republish'])
		).toMatchObject({
			exitCode: 1,
			stderr:
				'--group: required by --operation republish\nRun "expo-release operate --help" for usage.\n'
		})
	})
})
