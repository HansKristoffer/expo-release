#!/usr/bin/env bun

import { type CommandContext, defineCli, defineCommand } from 'hanzio/cli'
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
	type ReleaseDecision,
	writeDecideGitHubOutput
} from './decide'
import {
	type OperationInput,
	operateRelease,
	writeOperateGitHubOutput
} from './operate'

function toDecisionInput(options: ReleaseOptions): DecisionInput {
	return {
		base: options.base,
		head: options.head,
		profile: options.profile,
		platform: options.platform,
		impactPaths: options.impactPaths,
		ignoreExpoImpact: shouldIgnoreExpoImpact(options)
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

async function decide(options: ReleaseOptions, ctx: Context) {
	const decision = await decideRelease(toDecisionInput(options))
	await writeDecideGitHubOutput(decision)
	ctx.stdout.write(`${JSON.stringify(decision)}\n`)
	return decision
}

async function operate(
	options: ReleaseOptions,
	decision: ReleaseDecision | null,
	ctx: Context
) {
	const result = await operateRelease(toOperationInput(options, decision))
	await writeOperateGitHubOutput(result)
	ctx.stdout.write(`${result}\n`)
}

const COMMANDS: CommandName[] = ['release', 'decide', 'operate']

const cli = defineCli({
	name: 'expo-release',
	description:
		'Fingerprint-driven Expo EAS release: OTA update or native store build',
	// All three commands take the same flags, before or after the command name.
	globals: releaseFlags,
	context: (flags) => flags,
	commands: {
		release: defineCommand({
			description: 'Run decide, then operate on its decision',
			run: async (_input, ctx: Context) => {
				const options = toReleaseOptions('release', ctx)
				const decision = needsDecide(options.operation)
					? await decide(options, ctx)
					: null
				await operate(options, decision, ctx)
			}
		}),
		decide: defineCommand({
			description:
				'Print whether this change needs no deploy, an OTA update or a native build',
			run: async (_input, ctx: Context) => {
				await decide(toReleaseOptions('decide', ctx), ctx)
			}
		}),
		operate: defineCommand({
			description: 'Run --operation for --deploy-type',
			run: async (_input, ctx: Context) => {
				await operate(toReleaseOptions('operate', ctx), null, ctx)
			}
		})
	}
})

// GitHub Actions passes an unset input as an empty string; treat it as unset.
const env = Object.fromEntries(
	Object.entries(process.env).flatMap(([name, value]) =>
		value?.trim() ? [[name, value.trim()]] : []
	)
)

let argv = process.argv.slice(2)
if (!argv.some((arg) => COMMANDS.includes(arg as CommandName))) {
	// The composite action names the command in EXPO_RELEASE_COMMAND and passes no argv.
	argv = env.EXPO_RELEASE_COMMAND
		? [env.EXPO_RELEASE_COMMAND, ...argv]
		: argv.length === 0
			? ['--help']
			: argv
}

const code = await cli.run(argv, { env })
// Bad arguments exit 1, as before hanzio/cli, which uses 2.
process.exitCode = code === 2 ? 1 : code
