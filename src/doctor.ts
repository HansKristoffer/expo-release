import type { ReleasePlatform } from './args'
import type { BuildProfile, EasJson } from './eas-json'
import { readExpoSdkMajor } from './operate'
import { type CommandRunner, easCommand, runSilent } from './run'
import { expoCommand } from './source-maps'

export type Finding = {
	level: 'error' | 'warning'
	message: string
	/** The command or change that fixes it. */
	fix?: string
}

export type DoctorInput = {
	profile: string
	platform: ReleasePlatform
	environment?: string
	autoSubmit: boolean
	easJson: EasJson | null
	buildProfile: BuildProfile | null
	/** Also load the app config (`expo config`, slow in large apps). */
	full?: boolean
	readPackageJson?: () => Promise<unknown>
	readFile?: (path: string) => Promise<string | null>
	env?: Record<string, string | undefined>
	bunVersion?: string
}

const CREDENTIAL_FILE = /\.(keystore|jks|p8|p12|mobileprovision)$/

async function tryRun(runner: CommandRunner, command: string[]) {
	try {
		return { ok: true as const, output: await runner(command) }
	} catch (error) {
		return {
			ok: false as const,
			error: error instanceof Error ? error.message : String(error)
		}
	}
}

async function defaultReadFile(path: string): Promise<string | null> {
	const file = Bun.file(path)
	return (await file.exists()) ? file.text() : null
}

function versionOf(output: string): string | undefined {
	return output.match(/(\d+\.\d+\.\d+)/)?.[1]
}

async function checkTools(
	input: DoctorInput,
	runner: CommandRunner,
	findings: Finding[]
) {
	const env = input.env ?? process.env
	const eas = await tryRun(runner, easCommand('--version'))
	if (!eas.ok) {
		findings.push({
			level: 'error',
			message: 'eas-cli did not run.',
			fix: 'Add eas-cli to the app devDependencies, or set it up with expo/expo-github-action.'
		})
	} else {
		const wanted = input.easJson?.cli?.version
		const actual = versionOf(eas.output)
		if (wanted && actual && !Bun.semver.satisfies(actual, wanted)) {
			findings.push({
				level: 'error',
				message: `eas-cli ${actual} does not satisfy eas.json cli.version ${wanted}.`,
				fix: `Pin eas-cli ${wanted} in the app devDependencies or the workflow.`
			})
		}
	}
	if (env.CI && !env.EXPO_TOKEN) {
		findings.push({
			level: 'error',
			message: 'EXPO_TOKEN is not set.',
			fix: 'Add the EXPO_TOKEN secret (https://expo.dev/settings/access-tokens) and pass it to the job.'
		})
	}

	const bun = input.buildProfile?.bun
	const bunVersion = input.bunVersion ?? Bun.version
	if (bun && bun !== bunVersion) {
		findings.push({
			level: 'error',
			message: `This job runs Bun ${bunVersion}, the "${input.profile}" profile builds with Bun ${bun}. The fingerprint and lockfile can differ between them.`,
			fix: `Use Bun ${bun} in CI, or set build.${input.profile}.bun to ${bunVersion}.`
		})
	}
	const node = input.buildProfile?.node
	if (node) {
		const actual = await tryRun(runner, ['node', '--version'])
		const version = actual.ok ? versionOf(actual.output) : undefined
		if (version && version !== node) {
			findings.push({
				level: 'warning',
				message: `This job runs Node ${version}, the "${input.profile}" profile builds with Node ${node}.`,
				fix: `Use Node ${node} in CI (actions/setup-node).`
			})
		}
	}
}

async function checkProfile(input: DoctorInput, findings: Finding[]) {
	if (!input.easJson) {
		findings.push({
			level: 'error',
			message: 'No eas.json in the working directory.',
			fix: 'Set working-directory to the Expo app, or run `eas build:configure` there.'
		})
		return
	}
	if (!input.buildProfile) {
		const names = Object.keys(input.easJson.build ?? {}).join(', ') || 'none'
		findings.push({
			level: 'error',
			message: `eas.json has no build profile "${input.profile}" (profiles: ${names}).`
		})
		return
	}
	if (!input.buildProfile.channel) {
		findings.push({
			level: 'warning',
			message: `Build profile "${input.profile}" has no channel, so its builds receive no EAS updates.`,
			fix: `Set build.${input.profile}.channel in eas.json.`
		})
	}
	if (input.autoSubmit && !input.easJson.submit?.[input.profile]) {
		findings.push({
			level: 'warning',
			message: `auto-submit is on, but eas.json has no submit.${input.profile}.`,
			fix:
				input.platform === 'ios'
					? `Set submit.${input.profile}.ios.ascAppId.`
					: `Set submit.${input.profile}.android.serviceAccountKeyPath, pointing at a file from an EAS file secret.`
		})
	}
	if (!input.environment) {
		const major = await readExpoSdkMajor(input.readPackageJson)
		if (major !== null && major >= 55) {
			findings.push({
				level: 'error',
				message: 'Expo SDK 55+ needs an EAS environment for eas update.',
				fix: `Set build.${input.profile}.environment in eas.json, or pass --environment.`
			})
		}
	}
}

async function checkTrackedFiles(
	runner: CommandRunner,
	findings: Finding[],
	readFile: (path: string) => Promise<string | null>
) {
	const listed = await tryRun(runner, ['git', 'ls-files'])
	if (!listed.ok) return
	const files = listed.output.split('\n').filter(Boolean)

	const credentials = files.filter(
		(file) => CREDENTIAL_FILE.test(file) && !/(^|\/)debug\.keystore$/.test(file)
	)
	for (const file of files) {
		if (!file.endsWith('.json') || credentials.includes(file)) continue
		const text = await readFile(file)
		if (
			text &&
			text.length < 50_000 &&
			/"type"\s*:\s*"service_account"/.test(text)
		) {
			credentials.push(file)
		}
	}
	if (credentials.length > 0) {
		findings.push({
			level: 'error',
			message: `Credentials are committed: ${credentials.join(', ')}.`,
			fix: 'Remove them from git, rotate them, and keep them in EAS (`eas credentials`, EAS file secrets).'
		})
	}

	const generated = files.filter(
		(file) => /^\.expo\//.test(file) || /\.log$/.test(file)
	)
	if (generated.length > 0) {
		findings.push({
			level: 'warning',
			message: `Generated files are committed: ${generated.slice(0, 5).join(', ')}${generated.length > 5 ? `, and ${generated.length - 5} more` : ''}.`,
			fix: 'git rm --cached them and add .expo/ and *.log to .gitignore.'
		})
	}

	const nativeDirs = ['android', 'ios'].filter((dir) =>
		files.some((file) => file.startsWith(`${dir}/`))
	)
	if (nativeDirs.length === 0) return
	const ignore = (await readFile('.fingerprintignore')) ?? ''
	// Only a pattern for the whole folder hides it; `android/build/**` and the
	// like are ordinary ignores.
	const lines = ignore.split('\n').map((line) => line.trim().replace(/^\//, ''))
	const hidden = nativeDirs.filter((dir) =>
		lines.some((line) =>
			[dir, `${dir}/`, `${dir}/*`, `${dir}/**`, `${dir}/**/*`].includes(line)
		)
	)
	if (hidden.length > 0) {
		findings.push({
			level: 'error',
			message: `${hidden.join(' and ')} are committed, and .fingerprintignore hides them: EAS builds the committed tree, but a change there never asks for a native build.`,
			fix: 'Either delete and gitignore the native folders (continuous native generation), or stop ignoring them in .fingerprintignore.'
		})
	}
	return nativeDirs
}

async function checkAppConfig(
	runner: CommandRunner,
	findings: Finding[],
	nativeDirs: string[]
) {
	const config = await tryRun(runner, expoCommand('config', '--json'))
	if (!config.ok) {
		findings.push({
			level: 'error',
			message: `The app config did not load:\n${config.error}`,
			fix: 'Run `npx expo config` in the app with the same environment variables.'
		})
		return
	}
	let parsed: { runtimeVersion?: unknown; plugins?: unknown } = {}
	try {
		parsed = JSON.parse(config.output)
	} catch {
		return
	}
	const policy = (parsed.runtimeVersion as { policy?: unknown } | undefined)
		?.policy
	if (policy !== 'fingerprint') {
		findings.push({
			level: 'warning',
			message: `runtimeVersion is ${JSON.stringify(parsed.runtimeVersion ?? null)}, not { policy: 'fingerprint' }: an OTA can reach a binary whose native code differs.`,
			fix: "Set runtimeVersion: { policy: 'fingerprint' } in the app config."
		})
	}
	if (
		nativeDirs.length > 0 &&
		Array.isArray(parsed.plugins) &&
		parsed.plugins.length > 0
	) {
		findings.push({
			level: 'warning',
			message: `${nativeDirs.join(' and ')} are committed while the app config has plugins: EAS builds the committed tree and never applies config plugin changes.`,
			fix: 'Delete and gitignore the native folders, or run `npx expo prebuild` and commit after every plugin change.'
		})
	}
}

/** Checks what makes a release fail later, or ship the wrong thing. */
export async function runDoctor(
	input: DoctorInput,
	runner: CommandRunner = runSilent
): Promise<Finding[]> {
	const findings: Finding[] = []
	const readFile = input.readFile ?? defaultReadFile
	await checkProfile(input, findings)
	await checkTools(input, runner, findings)
	const nativeDirs = (await checkTrackedFiles(runner, findings, readFile)) ?? []
	if (input.full) await checkAppConfig(runner, findings, nativeDirs)
	return findings
}

function escapeAnnotation(text: string) {
	return text
		.replaceAll('%', '%25')
		.replaceAll('\r', '%0D')
		.replaceAll('\n', '%0A')
}

/** One line per finding; GitHub annotations inside Actions. */
export function formatFindings(
	findings: Finding[],
	options: { asWarnings?: boolean; github?: boolean } = {}
): string {
	return findings
		.map((finding) => {
			const level = options.asWarnings ? 'warning' : finding.level
			const text = finding.fix
				? `${finding.message}\nFix: ${finding.fix}`
				: finding.message
			return options.github
				? `::${level} title=expo-release doctor::${escapeAnnotation(text)}`
				: `${level}: ${text}`
		})
		.join('\n')
}
