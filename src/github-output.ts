export async function appendGitHubOutput(lines: string[]) {
	const outputPath = process.env.GITHUB_OUTPUT
	if (!outputPath) return

	const output = Bun.file(outputPath)
	const existing = (await output.exists()) ? await output.text() : ''
	await Bun.write(outputPath, `${existing}${lines.join('\n')}\n`)
}
