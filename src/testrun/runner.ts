import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { mkdir, rm } from "node:fs/promises"
import type { TestExecution } from "../types/cycle"
import type { TestRunnerConfig } from "../types/config"
import { classifyVerdict, matchRunner, type RunnerAdapter, type RunOptions } from "./adapter"
import { readStructuredReport, type ParsedReport } from "./report"

const execFileAsync = promisify(execFile)

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function toRelativeIfInside(cwd: string, file: string): string {
  const abs = path.isAbsolute(file) ? path.normalize(file) : path.normalize(path.join(cwd, file))
  const base = path.normalize(cwd)
  if (abs === base) return "."
  if (abs.startsWith(base + path.sep)) return abs.slice(base.length + 1)
  return file
}

function defaultReport(runner: TestRunnerConfig | undefined, format: "json" | "junit"): { args: string[] } | null {
  const id = runner?.id
  if (format === "json") {
    if (id === "vitest") return { args: ["--reporter=json", "--outputFile.json={file}"] }
    if (id === "jest") return { args: ["--json", "--outputFile={file}"] }
    // generic attempt
    return { args: ["--json", `--output-file={file}`] }
  }
  if (format === "junit") {
    if (id === "vitest") return { args: ["--reporter=junit", "--outputFile.junit={file}"] }
    if (id === "jest") return { args: ["--reporters=default", "--reporters=jest-junit"], } // requires env/config; best-effort fallback below
    if (id === "pytest") return { args: [`--junitxml={file}`] }
    if (id === "go") return null // go test doesn't emit junit natively
    return { args: [`--junitxml={file}`] }
  }
  return null
}

function buildReportArgs(runner: TestRunnerConfig | undefined, format: "json" | "junit" | "auto" | undefined, reportPath: string): { format: "json" | "junit"; args: string[] } | null {
  if (!format) return null
  const chosen: "json" | "junit" = format === "auto" ? (runner?.id === "pytest" ? "junit" : "json") : format
  if (runner?.reportArgs && runner.reportArgs.length > 0) {
    return { format: chosen, args: runner.reportArgs.map((a) => a.replaceAll("{file}", reportPath)) }
  }
  const def = defaultReport(runner, chosen)
  if (!def) return null
  return { format: chosen, args: def.args.map((a) => a.replaceAll("{file}", reportPath)) }
}

export function buildCommandForRun(opts: RunOptions, runner: TestRunnerConfig | undefined): { command: string; scoped: boolean } {
  const targets = (opts.targetTests ?? []).filter(Boolean)
  if (!runner || !runner.buildCommand || targets.length === 0 || !runner.command) {
    return { command: opts.command, scoped: false }
  }
  const relTargets = targets.map((t) => toRelativeIfInside(opts.cwd, t))
  const args = runner.scopeArgs(relTargets)
  const parts = [runner.command, ...args].filter((x) => x != null && String(x).length > 0)
  return { command: parts.map(shellQuote).join(" "), scoped: true }
}

export class GenericRunner implements RunnerAdapter {
  readonly id = "generic"
  matches(_command: string): boolean {
    return true
  }

  async run(opts: RunOptions): Promise<TestExecution> {
    const start = Date.now()
    const matched = matchRunner(opts.command, opts.runners)
    const built = buildCommandForRun(opts, matched)

    let reportPath: string | null = null
    let reportFormat: "json" | "junit" | null = null
    let command = built.command
    const reportPlan = buildReportArgs(matched, matched?.reportFormat, "__PLACEHOLDER__")
    if (reportPlan) {
      const dir = path.join(opts.cwd, ".kilo", "tdd", "reports")
      await mkdir(dir, { recursive: true }).catch(() => {})
      reportPath = path.join(dir, `run-${Date.now()}-${Math.random().toString(16).slice(2)}.${reportPlan.format === "json" ? "json" : "xml"}`)
      const actual = buildReportArgs(matched, matched?.reportFormat, reportPath)
      if (actual) {
        reportFormat = actual.format
        command = `${command} ${actual.args.map(shellQuote).join(" ")}`.trim()
      } else {
        reportPath = null
      }
    }

    let stdout = ""
    let stderr = ""
    let exitCode = 0
    try {
      const res = await execFileAsync("bash", ["-lc", command], {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
      })
      stdout = String(res.stdout ?? "")
      stderr = String(res.stderr ?? "")
      exitCode = 0
    } catch (err: any) {
      stdout = String(err?.stdout ?? "")
      stderr = String(err?.stderr ?? "")
      exitCode = typeof err?.code === "number" ? err.code : 1
    }
    const durationMs = Date.now() - start

    let report: ParsedReport | null = null
    if (reportPath && reportFormat) {
      report = await readStructuredReport(reportPath, reportFormat).catch(() => null)
      await rm(reportPath, { force: true }).catch(() => {})
    }

    const classified = classifyVerdict({
      command,
      stdout,
      stderr,
      exitCode,
      targetTests: opts.targetTests,
      skipIndicator: matched?.skipIndicator,
      runnerId: matched?.id,
      report,
    })
    const tags = [matched?.id ? `runner:${matched.id}` : null, built.scoped ? "scoped" : null, report ? `report:${report.format}` : null].filter(Boolean)
    const prefix = tags.length ? `[${tags.join(",")}] ` : ""
    return {
      testFiles: opts.targetTests ?? [],
      command,
      stdout,
      stderr,
      exitCode,
      finishedAt: Date.now(),
      durationMs,
      verdict: classified.verdict,
      verdictReason: `${prefix}${classified.reason}`,
      skipped: classified.skipped,
      hadCompileError: classified.hadCompileError,
    }
  }
}

export async function runTest(opts: RunOptions): Promise<TestExecution> {
  return new GenericRunner().run(opts)
}
