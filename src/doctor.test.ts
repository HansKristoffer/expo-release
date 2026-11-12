import { describe, expect, test } from 'bun:test'
import { type DoctorInput, formatFindings, runDoctor } from './doctor'

function input(overrides: Partial<DoctorInput> = {}): DoctorInput {
	return {
		profile: 'production',
		platform: 'ios',
		environment: 'production',
		autoSubmit: false,
		easJson: { build: { production: { channel: 'production' } } },
		buildProfile: { channel: 'production' },
		readPackageJson: async () => ({ dependencies: { expo: '~55.0.0' } }),
		readFile: async () => null,
		env: {},
		bunVersion: '1.4.4',
		...overrides
	}
}

function runner(responses: Record<string, string>) {
	return async (command: string[]) => {
		const key = command.slice(-2).join(' ')
		for (const [match, output] of Object.entries(responses)) {
			if (key.endsWith(match) || command.join(' ').includes(match))
				return output
		}
		throw new Error(`not found: ${command.join(' ')}`)
	}
}

const healthy = runner({
	'--version': 'eas-cli/16.32.0 darwin-arm64',
	'ls-files': ''
})

describe('runDoctor', () => {
	test('a healthy setup has no findings', async () => {
		expect(await runDoctor(input(), healthy)).toEqual([])
	})

	test('flags the setup problems that fail a release later', async () => {
		const findings = await runDoctor(
			input({
				environment: undefined,
				autoSubmit: true,
				easJson: {
					cli: { version: '>= 16.40.0' },
					build: { production: {} }
				},
				buildProfile: { bun: '1.4.0', node: '22.12.0' },
				env: { CI: 'true' }
			}),
			runner({
				'eas --version': 'eas-cli/16.32.0 linux-x64',
				'node --version': 'v22.20.0',
				'ls-files': ''
			})
		)
		expect(
			findings.map(
				(f) => `${f.level} ${f.message.split(' ').slice(0, 4).join(' ')}`
			)
		).toEqual([
			'warning Build profile "production" has',
			'warning auto-submit is on, but',
			'error Expo SDK 55+ needs',
			'error eas-cli 16.32.0 does not',
			'error EXPO_TOKEN is not set.',
			'error This job runs Bun',
			'warning This job runs Node'
		])
	})

	test('flags committed credentials, logs and native trees the fingerprint ignores', async () => {
		const files: Record<string, string> = {
			'.fingerprintignore': 'android\n/ios/**\n',
			'service-account.json': '{ "type": "service_account" }',
			'app.json': '{}'
		}
		const findings = await runDoctor(
			input({ readFile: async (path) => files[path] ?? null }),
			runner({
				'--version': 'eas-cli/16.32.0',
				'ls-files': [
					'release.keystore',
					'android/app/debug.keystore',
					'android/app/build.gradle',
					'ios/App.xcodeproj/project.pbxproj',
					'.expo/xcodebuild.log',
					'service-account.json',
					'app.json'
				].join('\n')
			})
		)
		expect(findings.map((f) => f.message)).toEqual([
			'Credentials are committed: release.keystore, service-account.json.',
			'Generated files are committed: .expo/xcodebuild.log.',
			'android and ios are committed, and .fingerprintignore hides them: EAS builds the committed tree, but a change there never asks for a native build.'
		])
	})

	test('ordinary ignores inside a committed native folder are fine', async () => {
		const findings = await runDoctor(
			input({
				readFile: async (path) =>
					path === '.fingerprintignore'
						? 'android/build/**\nios/Pods/**\nandroid/.gradle\n'
						: null
			}),
			runner({
				'--version': 'eas-cli/16.32.0',
				'ls-files': 'android/app/build.gradle\nios/Podfile'
			})
		)
		expect(findings).toEqual([])
	})

	test('the full run loads the app config', async () => {
		const findings = await runDoctor(
			input({ full: true }),
			runner({
				'--version': 'eas-cli/16.32.0',
				'ls-files': '',
				'config --json': '{"runtimeVersion":"1.0.0"}'
			})
		)
		expect(findings.map((f) => f.message)).toEqual([
			`runtimeVersion is "1.0.0", not { policy: 'fingerprint' }: an OTA can reach a binary whose native code differs.`
		])
	})
})

describe('formatFindings', () => {
	test('writes GitHub annotations with escaped newlines', () => {
		expect(
			formatFindings([{ level: 'error', message: 'a\nb', fix: 'c' }], {
				asWarnings: true,
				github: true
			})
		).toBe('::warning title=expo-release doctor::a%0Ab%0AFix: c')
	})
})
