import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { mkdir, rm, writeFile } from "node:fs/promises"
import type { TestExecution } from "../types/cycle"
import type { TestRunnerConfig } from "../types/config"
import { classifyVerdict, collectAttributedTargets, matchRunner, type RunnerAdapter, type RunOptions } from "./adapter"
import { readStructuredReport, type ParsedReport } from "./report"
import { trace, traceDetail } from "../log/trace"

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
  // Script/wrapper runners (e.g. npm/pnpm/yarn) may forward to unknown frameworks/versions;
  // do not inject guessed report flags by default. Honor explicit runner.reportArgs instead.
  if (!id || id === "npm" || id === "pnpm" || id === "yarn" || id === "bun") return null
  if (format === "json") {
    if (id === "vitest") return { args: ["--reporter=json", "--outputFile.json={file}"] }
    if (id === "jest") return { args: ["--json", "--outputFile={file}"] }
    if (id === "pytest") return { args: ["--json-report", "--json-report-file={file}"] }
    // unknown runner id: avoid injecting generic flags that may break the command
    return null
  }
  if (format === "junit") {
    if (id === "vitest") return { args: ["--reporter=junit", "--outputFile.junit={file}"] }
    if (id === "jest") return { args: ["--reporters=default", "--reporters=jest-junit"] } // requires env/config; best-effort
    if (id === "pytest") return { args: [`--junitxml={file}`] }
    if (id === "go") return null // go test doesn't emit junit natively
    return null
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

function truncateForDiagnostic(s: string, max = 40_000): { text: string; truncated: boolean; originalLength: number } {
  if (s.length <= max) return { text: s, truncated: false, originalLength: s.length }
  const head = Math.floor(max * 0.7)
  const tail = max - head
  return { text: `${s.slice(0, head)}\n\n...[truncated ${s.length - max} chars]...\n\n${s.slice(-tail)}`, truncated: true, originalLength: s.length }
}

function detectPassExitMismatch(out: string, exitCode: number, verdict: boolean | null): boolean {
  if (exitCode === 0 || verdict === true) return false
  const hasFailMarker = /\b(FAIL|FAILED|✗|✘|not ok)\b/i.test(out) || /\b\d+\s+failing\b/i.test(out) || /\b\d+\s+failed\b/i.test(out)
  const nodeFail = /(?:^|\n)\s*[#ℹ]\s*fail\s+(\d+)/i.exec(out)
  const explicitFailCount = (() => {
    const m = /\b(\d+)\s+failed\b/i.exec(out)
    return m ? Number(m[1]) : 0
  })()
  if (hasFailMarker || (nodeFail && Number(nodeFail[1]) > 0) || explicitFailCount > 0) return false

  const nodePass = /(?:^|\n)\s*[#ℹ]\s*pass\s+(\d+)/i.exec(out)
  if (nodePass && Number(nodePass[1]) > 0) return true
  const tapPlan = /(?:^|\n)\s*1\.\.(\d+)/m.exec(out)
  const tapNotOk = /(?:^|\n)\s*not ok\s+\d+/im.test(out)
  const tapOk = /(?:^|\n)\s*ok\s+\d+/im.test(out)
  if (tapOk && !tapNotOk && tapPlan && Number(tapPlan[1]) > 0) return true
  const passedCount = /\b(\d+)\s+passed\b/i.exec(out)
  if (passedCount && Number(passedCount[1]) > 0) return true
  if (/\bTests?:?\s+\d+\s+passed\b/i.test(out)) return true
  if (/\btest result:\s*ok\b/i.test(out)) return true
  // e.g. "5/5 passed"
  const frac = /\b(\d+)\s*\/\s*(\d+)\s+passed\b/i.exec(out)
  if (frac && Number(frac[1]) > 0 && Number(frac[1]) === Number(frac[2])) return true
  return false
}

async function maybeWriteExitMismatchDiagnostic(params: {
  cwd: string
  command: string
  originalCommand: string
  scoped: boolean
  runnerId?: string
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
  targetTests?: readonly string[]
  attributedFiles?: readonly string[]
  verdict: boolean | null
  verdictReason: string
  skipped: boolean
  hadCompileError: boolean
  reportSummary?: { format: string; total: number; passed: number; failed: number; skipped: number } | null
}): Promise<string | null> {
  const out = `${params.stdout}\n${params.stderr}`
  if (!detectPassExitMismatch(out, params.exitCode, params.verdict)) return null
  try {
    const dir = path.join(params.cwd, ".kilo", "tdd", "diagnostics")
    await mkdir(dir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, "-")
    const rand = Math.random().toString(16).slice(2, 8)
    const file = path.join(dir, `exit-mismatch-${ts}-${rand}.json`)
    const stdout = truncateForDiagnostic(params.stdout)
    const stderr = truncateForDiagnostic(params.stderr)
    const payload = {
      kind: "pass-output-nonzero-exit",
      createdAt: new Date().toISOString(),
      cwd: params.cwd,
      command: params.command,
      originalCommand: params.originalCommand,
      scoped: params.scoped,
      runnerId: params.runnerId ?? null,
      exitCode: params.exitCode,
      durationMs: params.durationMs,
      verdict: params.verdict,
      verdictReason: params.verdictReason,
      skipped: params.skipped,
      hadCompileError: params.hadCompileError,
      targetTests: params.targetTests ?? [],
      attributedFiles: params.attributedFiles ?? [],
      reportSummary: params.reportSummary ?? null,
      stdout,
      stderr,
      note: "Strong pass indicators detected in output but process exited non-zero and verdict was not GREEN. This may indicate wrapper/npm-script exit propagation or classifier mismatch.",
    }
    await writeFile(file, JSON.stringify(payload, null, 2), "utf8")
    return path.relative(params.cwd, file)
  } catch {
    return null
  }
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
    await trace(opts.cwd, "runner.start", {
      originalCommand: opts.command,
      builtCommand: built.command,
      scoped: built.scoped,
      runnerId: matched?.id ?? null,
      runnerMatch: matched?.match ?? null,
      runnerBuildCommand: matched?.buildCommand ?? null,
      targetTests: opts.targetTests ?? [],
      timeoutMs: opts.timeoutMs ?? 120_000,
    })

    let reportPath: string | null = null
    let reportFormat: "json" | "junit" | null = null
    let command = built.command
    const reportPlan = buildReportArgs(matched, matched?.reportFormat, "__PLACEHOLDER__")
    await trace(opts.cwd, "runner.report_plan", { reportPlan, matchedReportFormat: matched?.reportFormat ?? null })
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
    await trace(opts.cwd, "runner.command_final", { command, reportPath, reportFormat })

    let stdout = ""
    let stderr = ""
    let exitCode = 0
    let execError: any = null
    let timedOut = false
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
      execError = { message: String(err?.message ?? err), code: err?.code, signal: err?.signal, killed: err?.killed }
      stdout = String(err?.stdout ?? "")
      stderr = String(err?.stderr ?? "")
      exitCode = typeof err?.code === "number" ? err.code : 1
      timedOut = !!(err?.killed && (err?.signal === "SIGTERM" || err?.code === "ETIMEDOUT" || /timed out|timeout/i.test(String(err?.message ?? ""))))
    }
    const durationMs = Date.now() - start
    await trace(opts.cwd, "runner.exec_done", {
      command,
      exitCode,
      durationMs,
      timedOut,
      stdoutLength: stdout.length,
      stderrLength: stderr.length,
      stdoutTail: stdout.slice(-4000),
      stderrTail: stderr.slice(-4000),
      stdoutHead: stdout.slice(0, 2000),
      stderrHead: stderr.slice(0, 2000),
      execError,
    })

    let report: ParsedReport | null = null
    if (reportPath && reportFormat) {
      report = await readStructuredReport(reportPath, reportFormat).catch(() => null)
      await trace(opts.cwd, "runner.report_read", { reportPath, reportFormat, parsed: report ? { format: report.format, total: report.total, passed: report.passed, failed: report.failed, skipped: report.skipped, targets: report.targets } : null })
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
      cwd: opts.cwd,
      timedOut,
    })
    const attributedFiles = collectAttributedTargets({
      cwd: opts.cwd,
      verdict: classified.verdict,
      targets: opts.targetTests,
      stdout,
      stderr,
      report,
      command,
      classifyPath: (classified as any).debug?.path,
    })
    await trace(opts.cwd, "runner.classified", {
      verdict: classified.verdict,
      reason: classified.reason,
      skipped: classified.skipped,
      hadCompileError: classified.hadCompileError,
      attributedFiles,
      debug: (classified as any).debug ?? null,
    })
    const reportSummary = report ? { format: report.format, total: report.total, passed: report.passed, failed: report.failed, skipped: report.skipped } : null
    const diagPath = await maybeWriteExitMismatchDiagnostic({
      cwd: opts.cwd,
      command,
      originalCommand: opts.command,
      scoped: built.scoped,
      runnerId: matched?.id,
      stdout,
      stderr,
      exitCode,
      durationMs,
      targetTests: opts.targetTests,
      attributedFiles,
      verdict: classified.verdict,
      verdictReason: classified.reason,
      skipped: classified.skipped,
      hadCompileError: classified.hadCompileError,
      reportSummary,
    })
    if (diagPath) await trace(opts.cwd, "runner.exit_mismatch_diagnostic", { path: diagPath })
    const tags = [matched?.id ? `runner:${matched.id}` : null, built.scoped ? "scoped" : null, report ? `report:${report.format}` : null, diagPath ? "diag:exit-mismatch" : null].filter(Boolean)
    const prefix = tags.length ? `[${tags.join(",")}] ` : ""
    const reason = diagPath ? `${classified.reason} Diagnostic: ${diagPath}` : classified.reason
    const result: TestExecution = {
      testFiles: opts.targetTests ?? [],
      ...(attributedFiles.length ? { attributedFiles } : {}),
      command,
      stdout,
      stderr,
      exitCode,
      finishedAt: Date.now(),
      durationMs,
      verdict: classified.verdict,
      verdictReason: `${prefix}${reason}`,
      skipped: classified.skipped,
      hadCompileError: classified.hadCompileError,
    }
    const detailPath = await traceDetail(opts.cwd, "run", {
      ...result,
      originalCommand: opts.command,
      scoped: built.scoped,
      runnerId: matched?.id ?? null,
      reportSummary,
      diagPath,
      classifyDebug: (classified as any).debug ?? null,
    })
    await trace(opts.cwd, "runner.result", {
      verdict: result.verdict,
      verdictReason: result.verdictReason,
      exitCode: result.exitCode,
      attributedFiles: result.attributedFiles ?? [],
      detailPath,
    })
    return result
  }
}

export async function runTest(opts: RunOptions): Promise<TestExecution> {
  return new GenericRunner().run(opts)
}
