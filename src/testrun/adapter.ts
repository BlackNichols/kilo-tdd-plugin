import type { TestExecution } from "../types/cycle"
import type { TestRunnerConfig } from "../types/config"
import type { ParsedReport } from "./report"
import path from "node:path"

export interface RunOptions {
  cwd: string
  command: string
  timeoutMs?: number
  /** Optional files/targets the run is expected to exercise (for scoping/checks). */
  targetTests?: string[]
  /** Optional configured runners for command matching and runner-specific hints/building. */
  runners?: readonly TestRunnerConfig[]
}

export interface RunnerAdapter {
  id: string
  matches(command: string): boolean
  run(opts: RunOptions): Promise<TestExecution>
}

export function matchRunner(command: string, runners?: readonly TestRunnerConfig[]): TestRunnerConfig | undefined {
  if (!runners?.length) return undefined
  const cmd = command.trim()
  // prefer more specific/longer matches first
  const sorted = [...runners].sort((a, b) => Math.max(...b.match.map(m => m.length)) - Math.max(...a.match.map(m => m.length)))
  return sorted.find((r) => r.match.some((m) => cmd.includes(m)))
}

function normRel(p: string, cwd?: string): string {
  let s = String(p || "").replace(/\\/g, "/")
  if (cwd) {
    const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "")
    if (s.startsWith(base + "/")) s = s.slice(base.length + 1)
  }
  if (!s.startsWith("/") && cwd) {
    // keep relative
  }
  return s.replace(/^\.\/+/, "")
}

export function fileMentioned(out: string, file: string, cwd?: string): boolean {
  const rel = normRel(file, cwd)
  const base = rel.split("/").pop() ?? rel
  if (out.includes(file)) return true
  if (rel && out.includes(rel)) return true
  if (base && out.includes(base)) return true
  const bs = (file || "").replace(/\//g, "\\")
  if (bs && out.includes(bs)) return true
  const relBs = rel.replace(/\//g, "\\")
  if (relBs && out.includes(relBs)) return true
  return false
}

function targetsMentionedAnywhere(out: string, report: ParsedReport | null, targets: string[], cwd?: string): { any: boolean; allMissing: boolean; mentioned: string[] } {
  if (targets.length === 0) return { any: true, allMissing: false, mentioned: [] }
  const reportText = report ? report.targets.join("\n") : ""
  const mentioned: string[] = []
  for (const t of targets) {
    if (fileMentioned(out, t, cwd) || (report && fileMentioned(reportText, t, cwd))) mentioned.push(t)
  }
  return { any: mentioned.length > 0, allMissing: mentioned.length === 0, mentioned }
}

export function collectAttributedTargets(params: {
  cwd: string
  verdict: boolean | null
  targets?: string[]
  stdout?: string
  stderr?: string
  report?: ParsedReport | null
}): string[] {
  const targets = (params.targets ?? []).filter(Boolean)
  if (targets.length === 0) return []
  // Only attribute GREEN-passing coverage evidence to required test files.
  if (params.verdict !== true) return []
  const out = `${params.stdout ?? ""}\n${params.stderr ?? ""}`
  const { mentioned } = targetsMentionedAnywhere(out, params.report ?? null, targets, params.cwd)
  // normalize to repo-relative strings as provided
  return [...new Set(mentioned.map((t) => normRel(t, params.cwd)))]
}

export function classifyFromReport(
  report: ParsedReport,
  params: { exitCode: number; targets?: string[]; stdout?: string; stderr?: string; cwd?: string },
): { verdict: boolean | null; reason: string; skipped: boolean; hadCompileError: boolean } | null {
  const targets = (params.targets ?? []).filter(Boolean)
  const out = `${params.stdout ?? ""}\n${params.stderr ?? ""}`
  const mention = targetsMentionedAnywhere(out, report, targets, params.cwd)
  // If a report exists but shows nothing ran for explicit targets, be cautious
  if (targets.length > 0 && mention.allMissing && report.total === 0) {
    return { verdict: null, reason: `Structured ${report.format.toUpperCase()} report found but no executed tests attributable to target(s) (${targets.join(", ")}).`, skipped: true, hadCompileError: false }
  }
  if (targets.length > 0 && mention.allMissing && report.total > 0) {
    // report has results but target names not present - fail closed
    return { verdict: null, reason: `Structured ${report.format.toUpperCase()} report does not reference target test(s) (${targets.join(", ")}); cannot attribute verdict.`, skipped: report.skipped > 0, hadCompileError: false }
  }
  if (report.failed > 0) {
    return { verdict: false, reason: `Structured ${report.format.toUpperCase()} report: ${report.failed} failed, ${report.passed} passed, ${report.skipped} skipped (total ${report.total}).`, skipped: report.skipped > 0, hadCompileError: false }
  }
  if (report.total === 0) {
    return { verdict: null, reason: `Structured ${report.format.toUpperCase()} report indicates 0 tests executed.`, skipped: true, hadCompileError: false }
  }
  if (report.passed === 0 && report.skipped > 0) {
    return { verdict: null, reason: `Structured ${report.format.toUpperCase()} report indicates only skipped tests (${report.skipped}).`, skipped: true, hadCompileError: false }
  }
  if (params.exitCode === 0 && report.failed === 0) {
    return { verdict: true, reason: `Structured ${report.format.toUpperCase()} report: all ${report.passed} test(s) passed${report.skipped ? `, ${report.skipped} skipped` : ""}.`, skipped: report.skipped > 0, hadCompileError: false }
  }
  // exit nonzero but no failures recorded - ambiguous (infra/harness issue)
  return { verdict: null, reason: `Structured ${report.format.toUpperCase()} report recorded no failures but process exited ${params.exitCode}; cannot confirm result.`, skipped: report.skipped > 0, hadCompileError: false }
}

export function classifyVerdict(params: {
  command: string
  stdout: string
  stderr: string
  exitCode: number
  targetTests?: string[]
  skipIndicator?: RegExp
  runnerId?: string
  report?: ParsedReport | null
  cwd?: string
}): { verdict: boolean | null; reason: string; skipped: boolean; hadCompileError: boolean } {
  const out = `${params.stdout}\n${params.stderr}`

  // Structured report is primary evidence when present and parseable
  if (params.report) {
    const fromReport = classifyFromReport(params.report, { exitCode: params.exitCode, targets: params.targetTests, stdout: params.stdout, stderr: params.stderr, cwd: params.cwd })
    if (fromReport) return fromReport
  }

  const hadCompileError =
    /SyntaxError|Unexpected token|compilation failed|\btsc\b.*error|error TS\d+|Cannot find name/i.test(out)
  if (hadCompileError) {
    return {
      verdict: null,
      reason: "Compilation, syntax, or type error detected; not a valid RED failure.",
      skipped: false,
      hadCompileError: true,
    }
  }

  // Missing implementation module is a valid RED (test expects behavior that doesn't exist yet)
  const missingModule =
    /cannot find module|module not found|err_module_not_found|ERR_MODULE_NOT_FOUND|Cannot find package|no such file or directory.*\.(js|ts|mjs|cjs|jsx|tsx|py|go|rs)/i.test(out)
  if (missingModule && params.exitCode !== 0) {
    return {
      verdict: false,
      reason: "Test failed due to missing module/implementation (valid RED).",
      skipped: false,
      hadCompileError: false,
    }
  }

  const infra =
    /\bECONNREFUSED\b|\bECONNRESET\b|\bETIMEDOUT\b|\bEADDRINUSE\b|connection refused|database.*(unavailable|down)|command not found|timed out waiting for|Error: listen EACCES/i.test(out)
  if (infra) {
    return {
      verdict: null,
      reason: "Infrastructure, environment, or command failure detected; not a valid RED/GREEN verdict.",
      skipped: false,
      hadCompileError: false,
    }
  }

  const noTestsRan = /\b0 tests?\b|no tests? (found|ran|executed|matched)|no test files|no specs? found|did not match any tests/i.test(out)
  const countNonZero = (label: string) => {
    const before = new RegExp(`\\b(\\d+)\\s+${label}\\b`, "i").exec(out)
    const after = new RegExp(`\\b${label}\\s+(\\d+)\\b`, "i").exec(out)
    const eq = new RegExp(`\\b${label}\\s*=\\s*["'](\\d+)["']`, "i").exec(out)
    const n = before ? Number(before[1]) : after ? Number(after[1]) : eq ? Number(eq[1]) : null
    if (n !== null) return n > 0
    return new RegExp(`\\b${label}\\b`, "i").test(out)
  }
  const runnerSkip = params.skipIndicator ? params.skipIndicator.test(out) : false
  const hasSkipped = countNonZero("skipped")
  const hasPending = countNonZero("pending")
  const hasTodo = countNonZero("todo")
  const explicitSkip = noTestsRan || hasSkipped || hasPending || hasTodo
  const skipped = explicitSkip || runnerSkip
  if ((explicitSkip || (runnerSkip && params.exitCode === 0)) && params.exitCode === 0) {
    return {
      verdict: null,
      reason: runnerSkip && !explicitSkip
        ? "Runner reported a skip indicator; cannot be considered a pass or valid RED."
        : "No tests executed or tests were skipped/pending/todo; cannot be considered a pass or valid RED.",
      skipped: true,
      hadCompileError: false,
    }
  }

  const targets = (params.targetTests ?? []).filter(Boolean)
  const mention = targetsMentionedAnywhere(out, null, targets, params.cwd)
  const allTargetsMissing = mention.allMissing

  // Node test runner structured summary (node --test): "# pass N"/"ℹ pass N", "# fail N"/"ℹ fail N", etc.
  const nodeFail = /(?:^|\n)\s*[#ℹ]\s*fail\s+(\d+)/i.exec(out)
  const nodePass = /(?:^|\n)\s*[#ℹ]\s*pass\s+(\d+)/i.exec(out)
  const nodeSkip = /(?:^|\n)\s*[#ℹ]\s*skipped\s+(\d+)/i.exec(out) || /(?:^|\n)\s*[#ℹ]\s*todo\s+(\d+)/i.exec(out)
  if (nodeFail || nodePass) {
    const nf = nodeFail ? Number(nodeFail[1]) : 0
    const ns = nodeSkip ? Number(nodeSkip[1]) : 0
    const scopeNote = allTargetsMissing ? " (target file names not present in summary output)" : ""
    if (nf > 0) return { verdict: false, reason: `Node test reported ${nf} failing test(s) (valid RED)${scopeNote}.`, skipped: ns > 0, hadCompileError: false }
    if (params.exitCode === 0 && nf === 0) {
      return { verdict: true, reason: `Node test reported all tests passing${scopeNote}.`, skipped: ns > 0, hadCompileError: false }
    }
  }

  // If specific target tests were provided but none appear, fail closed before weaker inference
  if (allTargetsMissing) {
    return {
      verdict: null,
      reason: `Target test(s) not observed in output (${targets.join(", ")}); cannot attribute verdict to intended tests.`,
      skipped,
      hadCompileError: false,
    }
  }

  // TAP summary
  const tapNotOk = /(?:^|\n)\s*not ok\s+\d+/im.test(out)
  const tapOk = /(?:^|\n)\s*ok\s+\d+/im.test(out)
  const tapPlan = /(?:^|\n)\s*1\.\.(\d+)/m.exec(out)
  if (tapNotOk || (tapOk && tapPlan)) {
    if (tapNotOk) return { verdict: false, reason: "TAP reported failing test(s) (valid RED).", skipped, hadCompileError: false }
    if (params.exitCode === 0 && tapOk && !tapNotOk) return { verdict: true, reason: "TAP reported all tests passing.", skipped, hadCompileError: false }
  }

  // JUnit/XML-ish summary in output
  const junit = /<testsuite\b[^>]*\btests="(\d+)"[^>]*>/i.exec(out) || /<testsuites\b[^>]*\btests="(\d+)"[^>]*>/i.exec(out)
  if (junit) {
    const failures = /\bfailures="(\d+)"/i.exec(out)
    const errors = /\berrors="(\d+)"/i.exec(out)
    const skippedJ = /\bskipped="(\d+)"/i.exec(out)
    const nf = failures ? Number(failures[1]) : 0
    const ne = errors ? Number(errors[1]) : 0
    const ns = skippedJ ? Number(skippedJ[1]) : 0
    if (nf > 0 || ne > 0) return { verdict: false, reason: `JUnit reported ${nf} failure(s) and ${ne} error(s) (valid RED).`, skipped: ns > 0, hadCompileError: false }
    if (params.exitCode === 0) return { verdict: true, reason: "JUnit reported all tests passing.", skipped: ns > 0, hadCompileError: false }
  }

  // Vitest/Jest/pytest-like summaries
  const failedCount = /\b(\d+)\s+failed\b/i.exec(out)
  const passedCount = /\b(\d+)\s+passed\b/i.exec(out)
  if (failedCount && Number(failedCount[1]) > 0) {
    return { verdict: false, reason: `Test runner reported ${failedCount[1]} failing test(s) (valid RED).`, skipped, hadCompileError: false }
  }
  if (params.exitCode === 0 && (passedCount || /\bTests?:?\s+\d+\s+passed\b/i.test(out) || /\bPASS\b/.test(out))) {
    return { verdict: true, reason: "All relevant tests passed.", skipped, hadCompileError: false }
  }

  if (params.exitCode === 0) {
    const hasFailMarker = /\b(FAIL|FAILED|✗|✘|not ok)\b/i.test(out)
    const hasPassMarker = /\b(PASS|PASSED|✓|✔|ok)\b/i.test(out) || /test(s)? passed/i.test(out)
    if (hasPassMarker && !hasFailMarker) {
      return { verdict: true, reason: "Command exited 0 with pass indicators and no failures.", skipped, hadCompileError: false }
    }
    return { verdict: true, reason: "Command exited 0 with no failure indicators.", skipped, hadCompileError: false }
  }

  const assertionFail =
    /\b(FAIL|FAILED|AssertionError|expect\(|Expected|Received|toBe|toEqual|toStrictEqual|assert\.|Assertion failed)\b/i.test(out) ||
    /\b\d+\s+failing\b/i.test(out) || /\bnot ok\b/i.test(out) || /✗|✘/i.test(out)

  if (assertionFail) {
    return {
      verdict: false,
      reason: "Test failed with assertion/expectation failure (valid RED).",
      skipped,
      hadCompileError: false,
    }
  }

  if (targets.length > 0 && mention.any) {
    return {
      verdict: false,
      reason: `Nonzero exit (${params.exitCode}) with target test referenced in output; treated as failing run (likely RED).`,
      skipped,
      hadCompileError: false,
    }
  }

  return {
    verdict: null,
    reason: `Nonzero exit (${params.exitCode}) but failure type is ambiguous; cannot confirm valid RED.`,
    skipped,
    hadCompileError: false,
  }
}
