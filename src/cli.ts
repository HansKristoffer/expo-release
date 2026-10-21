#!/usr/bin/env bun

import {
	CliUsageError,
	type CommandContext,
	defineCli,
	defineCommand
} from 'hanzio/cli'
import {
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

const cli = defineCli({
	name: 'expo-release',
	description:
		'Fingerprint-driven Expo EAS release: OTA update or native store build',
	// All three commands take the same flags, before or after the command name.
	globals: releaseFlags,
	context: (flags) => flags,
	// The composite action names the command in EXPO_RELEASE_COMMAND and passes no argv.
	defaultCommand: (env) => env.EXPO_RELEASE_COMMAND?.trim() || undefined,
	onError: (error, io) => {
		// With no arguments at all, print help and exit 0.
		if (
			error instanceof CliUsageError &&
			error.kind === 'missing-command' &&
			process.argv.length <= 2
		) {
			io.stdout.write(error.help)
			return 0
		}
		// Bad arguments exit 1, as before hanzio/cli, which uses 2.
		const code = io.print()
		return code === 2 ? 1 : code
	},
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

process.exitCode = await cli.run()
