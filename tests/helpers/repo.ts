import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export async function git(cwd: string, args: string[]) {
  const { stdout, stderr } = await execFileAsync("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
  return { stdout: String(stdout), stderr: String(stderr) }
}

export interface TempRepo {
  dir: string
  cleanup: () => Promise<void>
}

export async function makeTempRepo(): Promise<TempRepo> {
  const dir = await mkdtemp(path.join(tmpdir(), "kilo-tdd-"))
  await git(dir, ["init", "-b", "main"])
  await git(dir, ["config", "user.email", "test@example.com"])
  await git(dir, ["config", "user.name", "Test"])
  await mkdir(path.join(dir, "src"), { recursive: true })
  await mkdir(path.join(dir, "tests"), { recursive: true })
  await writeFile(path.join(dir, "src", "placeholder.ts"), "export const placeholder = 1;\n")
  await git(dir, ["add", "."])
  await git(dir, ["commit", "-m", "initial"])
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true })
    },
  }
}
