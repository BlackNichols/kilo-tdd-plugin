import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export interface GitResult {
  stdout: string
  stderr: string
  exitCode: number
}

export class GitClient {
  constructor(readonly cwd: string) {}

  async run(args: string[]): Promise<GitResult> {
    try {
      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd: this.cwd,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      })
      return { stdout: String(stdout), stderr: String(stderr), exitCode: 0 }
    } catch (err: any) {
      if (err && typeof err === "object" && "stdout" in err) {
        return {
          stdout: String(err.stdout ?? ""),
          stderr: String(err.stderr ?? ""),
          exitCode: typeof err.code === "number" ? err.code : 1,
        }
      }
      throw err
    }
  }

  async mustRun(args: string[]): Promise<GitResult> {
    const res = await this.run(args)
    if (res.exitCode !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed (${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}`,
      )
    }
    return res
  }

  async head(): Promise<string> {
    return (await this.mustRun(["rev-parse", "HEAD"])).stdout.trim()
  }

  async shortSha(sha: string): Promise<string> {
    return (await this.mustRun(["rev-parse", "--short", sha])).stdout.trim()
  }

  async branch(): Promise<string> {
    const res = await this.run(["rev-parse", "--abbrev-ref", "HEAD"])
    if (res.exitCode !== 0) return "HEAD"
    return res.stdout.trim()
  }

  async isRepo(): Promise<boolean> {
    const res = await this.run(["rev-parse", "--is-inside-work-tree"])
    return res.exitCode === 0 && res.stdout.trim() === "true"
  }

  async statusPorcelain(): Promise<string> {
    return (await this.mustRun(["status", "--porcelain"])).stdout
  }

  async isClean(): Promise<boolean> {
    return (await this.statusPorcelain()).trim().length === 0
  }

  async inProgressOperation(): Promise<string | null> {
    const heads = ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"]
    for (const name of heads) {
      const res = await this.run(["rev-parse", "--verify", "-q", name])
      if (res.exitCode === 0) return name
    }
    const gitDirRes = await this.run(["rev-parse", "--git-dir"])
    if (gitDirRes.exitCode !== 0) return null
    const gitDirRaw = gitDirRes.stdout.trim()
    const gitDir = path.isAbsolute(gitDirRaw) ? gitDirRaw : path.join(this.cwd, gitDirRaw)
    for (const dir of ["rebase-merge", "rebase-apply"]) {
      try {
        await readFile(path.join(gitDir, dir, "head-name"))
        return dir
      } catch {}
    }
    return null
  }

  async stagedAll(): Promise<string[]> {
    const res = await this.mustRun(["diff", "--cached", "--name-only"])
    return splitLines(res.stdout)
  }

  async unstagedFiles(): Promise<string[]> {
    const res = await this.mustRun(["diff", "--name-only"])
    return splitLines(res.stdout)
  }

  async untrackedFiles(): Promise<string[]> {
    const res = await this.mustRun(["ls-files", "--others", "--exclude-standard"])
    return splitLines(res.stdout)
  }

  async allDirtyFiles(): Promise<string[]> {
    const rawLines = (await this.mustRun(["status", "--porcelain"])).stdout.split("\n")
    const files: string[] = []
    for (const line of rawLines) {
      if (!line.trim()) continue
      // porcelain v1: "XY PATH" or "XY ORIG -> PATH" for renames
      const raw = line.length > 2 ? line.slice(2).trimStart() : line.trim()
      const arrow = raw.indexOf(" -> ")
      const p = arrow >= 0 ? raw.slice(arrow + 4).trim() : raw.trim()
      if (!p) continue
      if (p.endsWith("/")) {
        // untracked directory: expand to contained files
        const inside = await this.untrackedFilesInDir(p)
        if (inside.length) files.push(...inside)
        else files.push(p)
      } else {
        files.push(p)
      }
    }
    return [...new Set(files)].filter(Boolean).sort()
  }

  async untrackedFilesInDir(dir: string): Promise<string[]> {
    const res = await this.run(["ls-files", "--others", "--exclude-standard", "--", dir])
    if (res.exitCode !== 0) return []
    return splitLines(res.stdout)
  }

  async addFiles(files: string[]): Promise<void> {
    if (files.length === 0) return
    await this.mustRun(["add", "--", ...files])
  }

  async commit(message: string): Promise<string> {
    await this.mustRun(["commit", "-m", message])
    return this.head()
  }

  async amend(message: string): Promise<string> {
    await this.mustRun(["commit", "--amend", "-m", message])
    return this.head()
  }

  async restoreFrom(sha: string, files: string[]): Promise<void> {
    if (files.length === 0) return
    await this.mustRun(["checkout", sha, "--", ...files])
  }

  async diffStaged(): Promise<string> {
    return (await this.mustRun(["diff", "--cached"])).stdout
  }

  async filesInCommit(sha: string): Promise<string[]> {
    const res = await this.mustRun(["show", "--name-only", "--format=", sha])
    return splitLines(res.stdout)
  }

  async blobSha(sha: string, file: string): Promise<string | null> {
    const res = await this.run(["rev-parse", `${sha}:${file}`])
    if (res.exitCode !== 0) return null
    return res.stdout.trim()
  }

  async hashWorkingFile(absPath: string): Promise<string> {
    const buf = await readFile(absPath)
    return createHash("sha256").update(buf).digest("hex")
  }

  async hashCommitFiles(sha: string, files: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const f of files) {
      const blob = await this.blobSha(sha, f)
      if (blob) out[f] = blob
    }
    return out
  }
}

function splitLines(s: string): string[] {
  return s
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean)
}