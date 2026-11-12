#!/usr/bin/env bun

import { relative } from 'node:path'
import {
	CliUsageError,
	type CommandContext,
	defineCli,
	defineCommand
} from 'hanzio/cli'
import {
	type CommandName,
	needsDecide,
	type ReleaseFlags,
	type ReleaseOptions,
	releaseFlags,
	shouldIgnoreExpoImpact,
	toReleaseOptions
} from './args'
import {
	type DecisionInput,
	decideRelease,
	type EASBuild,
	type ReleaseDecision,
	writeDecideGitHubOutput
} from './decide'
import { formatFindings, runDoctor } from './doctor'
import {
	applyProfileEnv,
	type BuildProfile,
	type EasJson,
	readEasJson,
	resolveBuildProfile
} from './eas-json'
import { appendGitHubOutput } from './github-output'
import {
	type OperationInput,
	operateRelease,
	readExpoSdkMajor,
	writeOperateGitHubOutput
} from './operate'
import { type Stage, StageError } from './run'

const inGitHubActions = process.env.GITHUB_ACTIONS === 'true'

// Metro caches in $TMPDIR/metro-cache. On a shared self-hosted machine
// /tmp/metro-cache can belong to another user (EACCES); the job's temp
// directory is ours.
if (
	process.env.RUNNER_ENVIRONMENT === 'self-hosted' &&
	process.env.RUNNER_TEMP &&
	!process.env.TMPDIR
) {
	process.env.TMPDIR = process.env.RUNNER_TEMP
}

type Prepared = {
	options: ReleaseOptions
	easJson: EasJson | null
	buildProfile: BuildProfile | null
}

// Read by onError, which gets no context.
let current: Prepared | null = null

async function prepare(command: CommandName, ctx: Context): Promise<Prepared> {
	const platform = ctx.context.platform
	const easJson = await readEasJson()
	const buildProfile = easJson
		? resolveBuildProfile(easJson, ctx.context.profile, platform)
		: null
	const applied = applyProfileEnv(buildProfile)
	if (applied.length > 0) {
		process.stderr.write(
			`[expo-release] env from eas.json build.${ctx.context.profile}: ${applied.join(', ')}\n`
		)
	}
	// `eas update --environment` also turns off .env loading, so the profile's
	// environment is a default only where SDK 55+ requires one anyway.
	const sdk = await readExpoSdkMajor().catch(() => null)
	const defaults =
		buildProfile && (sdk === null || sdk < 55)
			? { ...buildProfile, environment: undefined }
			: buildProfile
	current = {
		options: toReleaseOptions(command, ctx, defaults),
		easJson,
		buildProfile
	}
	return current
}

function doctorInput(prepared: Prepared, full: boolean) {
	const { options } = prepared
	return {
		profile: options.profile,
		platform: options.platform,
		environment: options.environment,
		autoSubmit: options.autoSubmit,
		easJson: prepared.easJson,
		buildProfile: prepared.buildProfile,
		full
	}
}

function toDecisionInput(prepared: Prepared): DecisionInput {
	const { options } = prepared
	return {
		base: options.base,
		head: options.head,
		profile: options.profile,
		platform: options.platform,
		impactPaths: options.impactPaths,
		ignoreExpoImpact: shouldIgnoreExpoImpact(options),
		environment: options.environment,
		// The quick checks, as warnings: they explain a failure that follows.
		preflight: async () => {
			const findings = await runDoctor(doctorInput(prepared, false)).catch(
				() => []
			)
			if (findings.length > 0) {
				process.stderr.write(
					`${formatFindings(findings, { asWarnings: true, github: inGitHubActions })}\n`
				)
			}
		}
	}
}

function toOperationInput(
	options: ReleaseOptions,
	decision: ReleaseDecision | null
): OperationInput {
	return {
		profile: options.profile,
		deployType: decision?.deployType ?? options.deployType,
		operation: options.operation,
		channel: options.channel,
		environment: options.environment,
		platform: options.platform,
		autoSubmit: options.autoSubmit,
		fingerprint: options.fingerprint ?? decision?.fingerprint ?? undefined,
		group: options.group,
		runtimeVersion: options.runtimeVersion,
		message: options.message,
		preUpdate: options.preUpdate,
		postUpdate: options.postUpdate,
		updateExtraArgs: options.updateExtraArgs,
		exportSourceMaps: options.exportSourceMaps,
		dryRun: options.dryRun
	}
}

type Context = CommandContext<ReleaseFlags>

async function decide(prepared: Prepared, ctx: Context) {
	const decision = await decideRelease(toDecisionInput(prepared))
	await writeDecideGitHubOutput(decision)
	ctx.stdout.write(`${JSON.stringify(decision)}\n`)
	return decision
}

async function operate(
	options: ReleaseOptions,
	decision: ReleaseDecision | null,
	ctx: Context
) {
	let queued: EASBuild | undefined
	const result = await operateRelease({
		...toOperationInput(options, decision),
		onQueuedBuild: (build) => {
			queued = build
		}
	})
	await writeOperateGitHubOutput(result, queued)
	ctx.stdout.write(`${result}\n`)
}

/** A fixed next step per stage, never guessed from EAS's wording. */
function nextStep(stage: Stage, options: ReleaseOptions): string {
	const app = relative(
		process.env.GITHUB_WORKSPACE ?? process.cwd(),
		process.cwd()
	)
	const from = app ? `From ${app}: ` : ''
	const { platform, profile } = options
	switch (stage) {
		case 'doctor':
			return 'Fix the findings above; `expo-release doctor` runs the same checks.'
		case 'diff':
			return 'Check out with fetch-depth: 0 so both commits of the diff exist.'
		case 'fingerprint':
			return `The app config or EAS project did not load. ${from}\`npx expo config\` and \`eas fingerprint:generate --platform ${platform} --build-profile ${profile}\` with the job's environment variables.`
		case 'build list':
		case 'fingerprint diff':
			return `Check that EXPO_TOKEN can read this project. ${from}\`eas build:list --platform ${platform} --build-profile ${profile}\`.`
		case 'errored build':
			return 'Fix the build failure on EAS, then run the workflow with operation force-native.'
		case 'native build':
			return `A native build that fails before it is queued usually needs one interactive run. ${from}\`eas credentials:configure-build --platform ${platform} --profile ${profile}\`.`
		case 'ota export':
		case 'ota update':
			return 'Fix the bundle error above, then run the workflow with operation retry-ota.'
		case 'pre-update':
		case 'post-update':
			return `The ${stage} command failed; it is the workflow's own step.`
		case 'recovery':
			return 'Check the group or runtime version passed to the recovery operation.'
		default: {
			const _exhaustive: never = stage
			return _exhaustive
		}
	}
}

function escapeData(text: string) {
	return text
		.replaceAll('%', '%25')
		.replaceAll('\r', '%0D')
		.replaceAll('\n', '%0A')
}

function escapeProperty(text: string) {
	return escapeData(text).replaceAll(':', '%3A').replaceAll(',', '%2C')
}

async function reportFailure(
	error: Error,
	io: { stderr: { write(text: string): unknown } }
) {
	const stage = error instanceof StageError ? error.stage : undefined
	const options = current?.options
	const said = error instanceof StageError ? error.tail : []
	const next = stage && options ? nextStep(stage, options) : undefined

	io.stderr.write(`${error.message}\n`)
	if (inGitHubActions) {
		const where = options ? ` (${options.profile}, ${options.platform})` : ''
		const title = `expo-release: ${stage ?? 'release'} failed${where}`
		const message = said.slice(-3).join('\n') || error.message
		io.stderr.write(
			`::error title=${escapeProperty(title)}::${escapeData(message)}\n`
		)
	}
	await appendGitHubOutput({
		result: 'failed',
		failed_stage: stage ?? '',
		failure: [
			said.length > 0 ? `EAS said:\n${said.join('\n')}` : error.message,
			next ? `Next: ${next}` : ''
		]
			.filter(Boolean)
			.join('\n')
	})
}

const cli = defineCli({
	name: 'expo-release',
	description:
		'Fingerprint-driven Expo EAS release: OTA update or native store build',
	// Every command takes the same flags, before or after the command name.
	globals: releaseFlags,
	context: (flags) => flags,
	// The composite action names the command in EXPO_RELEASE_COMMAND and passes no argv.
	defaultCommand: (env) => env.EXPO_RELEASE_COMMAND?.trim() || undefined,
	onError: async (error, io) => {
		if (error instanceof CliUsageError) {
			// With no arguments at all, print help and exit 0.
			if (error.kind === 'missing-command' && process.argv.length <= 2) {
				io.stdout.write(error.help)
				return 0
			}
			// Bad arguments exit 1, as before hanzio/cli, which uses 2.
			const code = io.print()
			return code === 2 ? 1 : code
		}
		// An expected failure: the message, an annotation and outputs; no stack.
		if (error instanceof Error) {
			await reportFailure(error, io)
			return 1
		}
		return io.print()
	},
	commands: {
		release: defineCommand({
			description: 'Run decide, then operate on its decision',
			run: async (_input, ctx: Context) => {
				const prepared = await prepare('release', ctx)
				const decision = needsDecide(prepared.options.operation)
					? await decide(prepared, ctx)
					: null
				await operate(prepared.options, decision, ctx)
			}
		}),
		decide: defineCommand({
			description:
				'Print whether this change needs no deploy, an OTA update or a native build, and why',
			run: async (_input, ctx: Context) => {
				await decide(await prepare('decide', ctx), ctx)
			}
		}),
		operate: defineCommand({
			description: 'Run --operation for --deploy-type',
			run: async (_input, ctx: Context) => {
				await operate((await prepare('operate', ctx)).options, null, ctx)
			}
		}),
		doctor: defineCommand({
			description:
				'Check the EAS setup, the app config and the committed files; exit 1 on an error',
			run: async (_input, ctx: Context) => {
				const prepared = await prepare('doctor', ctx)
				const findings = await runDoctor(doctorInput(prepared, true))
				if (findings.length === 0) {
					ctx.stdout.write('No problems found.\n')
					return
				}
				ctx.stdout.write(
					`${formatFindings(findings, { github: inGitHubActions })}\n`
				)
				if (findings.some((finding) => finding.level === 'error')) {
					throw new StageError(
						'doctor',
						`${findings.filter((f) => f.level === 'error').length} doctor check(s) failed.`
					)
				}
			}
		})
	}
})

process.exitCode = await cli.run()
