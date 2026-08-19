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

const USAGE = 'Usage: expo-release <decide|operate> --profile <profile> ...'

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
		default:
			throw new Error(USAGE)
	}
}

await main()
