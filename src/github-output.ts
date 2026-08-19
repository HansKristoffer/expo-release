import { appendFile } from 'node:fs/promises'

export async function appendGitHubOutput(entries: Record<string, string>) {
	const outputPath = process.env.GITHUB_OUTPUT
	if (!outputPath) return

	const lines = Object.entries(entries).map(([key, value]) => {
		const delimiter = `EOF_${key}_${crypto.randomUUID().replaceAll('-', '')}`
		return `${key}<<${delimiter}\n${value}\n${delimiter}`
	})
	await appendFile(outputPath, `${lines.join('\n')}\n`)
}
