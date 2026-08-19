#!/usr/bin/env bun

import {
	decideRelease,
	parseDecideArgs,
	writeDecideGitHubOutput
} from './decide'
import {
	operateRelease,
	parseOperateArgs,
	writeOperateGitHubOutput
} from './operate'

const USAGE =
	'Usage: expo-release <release|decide|operate> --profile <profile> ...'

function withDefaultFlags(args: string[], flags: Record<string, string>) {
	const next = [...args]
	for (const [key, value] of Object.entries(flags)) {
		if (!next.includes(`--${key}`)) {
			next.push(`--${key}`, value)
		}
	}
	return next
}

async function main() {
	const [command, ...args] = Bun.argv.slice(2)
	switch (command) {
		case 'decide': {
			const decision = await decideRelease(parseDecideArgs(args))
			await writeDecideGitHubOutput(decision)
			process.stdout.write(`${JSON.stringify(decision)}\n`)
			return
		}
		case 'operate': {
			const result = await operateRelease(parseOperateArgs(args))
			await writeOperateGitHubOutput(result)
			process.stdout.write(`${result}\n`)
			return
		}
		case 'release': {
			const decision = await decideRelease(parseDecideArgs(args))
			await writeDecideGitHubOutput(decision)
			process.stdout.write(`${JSON.stringify(decision)}\n`)
			const result = await operateRelease(
				parseOperateArgs(
					withDefaultFlags(args, {
						action: decision.action,
						operation: 'deploy'
					})
				)
			)
			await writeOperateGitHubOutput(result)
			process.stdout.write(`${result}\n`)
			return
		}
		default:
			throw new Error(USAGE)
	}
}

await main()
