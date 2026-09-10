#!/usr/bin/env bun

import {
	type ReleaseOptions,
	USAGE,
	needsDecide,
	parseReleaseOptions,
	shouldIgnoreExpoImpact
} from './args'
import {
	type DecisionInput,
	type ReleaseDecision,
	decideRelease,
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

async function main() {
	const raw = Bun.argv.slice(2)
	// The composite action passes everything through EXPO_RELEASE_* env vars and no argv.
	const hasEnvCommand = Boolean(process.env.EXPO_RELEASE_COMMAND?.trim())
	if ((raw.length === 0 && !hasEnvCommand) || raw[0] === '--help' || raw[0] === '-h') {
		process.stdout.write(`${USAGE}\n`)
		return
	}

	const options = parseReleaseOptions(raw)

	switch (options.command) {
		case 'decide': {
			const decision = await decideRelease(toDecisionInput(options))
			await writeDecideGitHubOutput(decision)
			process.stdout.write(`${JSON.stringify(decision)}\n`)
			return
		}
		case 'operate': {
			const result = await operateRelease(toOperationInput(options, null))
			await writeOperateGitHubOutput(result)
			process.stdout.write(`${result}\n`)
			return
		}
		case 'release': {
			let decision: ReleaseDecision | null = null
			if (needsDecide(options.operation)) {
				decision = await decideRelease(toDecisionInput(options))
				await writeDecideGitHubOutput(decision)
				process.stdout.write(`${JSON.stringify(decision)}\n`)
			}
			const result = await operateRelease(toOperationInput(options, decision))
			await writeOperateGitHubOutput(result)
			process.stdout.write(`${result}\n`)
			return
		}
		default: {
			const _exhaustive: never = options.command
			throw new Error(`Unsupported command: ${_exhaustive}`)
		}
	}
}

await main()
