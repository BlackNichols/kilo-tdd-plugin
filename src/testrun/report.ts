import { readFile } from "node:fs/promises"

export interface ParsedReport {
  format: "json" | "junit"
  total: number
  passed: number
  failed: number
  skipped: number
  /** file/test names observed in report */
  targets: string[]
  raw?: unknown
}

function toInt(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN
  return Number.isFinite(n) ? n : 0
}

function collectStrings(obj: any, keys: string[], out: string[]) {
  if (!obj || typeof obj !== "object") return
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === "string" && v) out.push(v)
  }
  if (Array.isArray(obj)) for (const x of obj) collectStrings(x, keys, out)
  else for (const v of Object.values(obj)) collectStrings(v, keys, out)
}

export function parseJsonReport(content: string): ParsedReport | null {
  let data: any
  try {
    data = JSON.parse(content)
  } catch {
    return null
  }
  if (!data || typeof data !== "object") return null

  // Vitest/Jest-like: { numTotalTests, numPassedTests, numFailedTests, numPendingTests, testResults:[{name,status,...}] }
  if (typeof data.numTotalTests === "number" || Array.isArray(data.testResults)) {
    const failed = toInt(data.numFailedTests ?? data.numFailingTests)
    const passed = toInt(data.numPassedTests ?? data.numPassingTests)
    const skipped = toInt(data.numPendingTests) + toInt(data.numTodoTests)
    const total = toInt(data.numTotalTests) || (passed + failed + skipped)
    const targets: string[] = []
    if (Array.isArray(data.testResults)) {
      for (const tr of data.testResults) {
        if (tr?.name) targets.push(String(tr.name))
        if (tr?.testFilePath) targets.push(String(tr.testFilePath))
        if (Array.isArray(tr?.assertionResults)) {
          for (const a of tr.assertionResults) {
            if (a?.fullName) targets.push(String(a.fullName))
            if (a?.title) targets.push(String(a.title))
          }
        }
      }
    }
    collectStrings(data, ["name", "testFilePath", "file"], targets)
    return { format: "json", total, passed, failed, skipped, targets: [...new Set(targets)], raw: data }
  }

  // Playwright-like: { stats: { expected, unexpected, skipped, flaky }, suites: [...] }
  if (data.stats && typeof data.stats === "object") {
    const failed = toInt(data.stats.unexpected) + toInt(data.stats.failed)
    const passed = toInt(data.stats.expected) + toInt(data.stats.passed)
    const skipped = toInt(data.stats.skipped) + toInt(data.stats.flaky ? 0 : 0)
    const total = toInt(data.stats.total) || (passed + failed + skipped)
    const targets: string[] = []
    collectStrings(data, ["file", "title", "path"], targets)
    return { format: "json", total, passed, failed, skipped, targets: [...new Set(targets)], raw: data }
  }

  // Pytest-json-report-like: { summary: { passed, failed, skipped, total }, tests:[...] }
  if (data.summary && typeof data.summary === "object") {
    const failed = toInt(data.summary.failed) + toInt(data.summary.error)
    const passed = toInt(data.summary.passed)
    const skipped = toInt(data.summary.skipped) + toInt(data.summary.xfailed) + toInt(data.summary.xpassed)
    const total = toInt(data.summary.total) || (passed + failed + skipped)
    const targets: string[] = []
    if (Array.isArray(data.tests)) for (const t of data.tests) { if (t?.nodeid) targets.push(String(t.nodeid)) }
    collectStrings(data, ["nodeid", "file", "name"], targets)
    return { format: "json", total, passed, failed, skipped, targets: [...new Set(targets)], raw: data }
  }

  // Go test -json aggregate? not a single object usually, but if someone aggregated
  if (typeof data.Action === "string" && data.Package) {
    return null
  }

  return null
}

export function parseJunitReport(content: string): ParsedReport | null {
  if (!/<testsuite|<testsuites/i.test(content)) return null
  // best-effort regex parse (no XML parser dependency)
  const suiteRe = /<testsuite\b([^>]*)>/gi
  let total = 0, failed = 0, skipped = 0, passed = 0
  let m: RegExpExecArray | null
  let any = false
  while ((m = suiteRe.exec(content))) {
    any = true
    const attrs = m[1] || ""
    const tests = toInt(/tests="(\d+)"/i.exec(attrs)?.[1])
    const failures = toInt(/failures="(\d+)"/i.exec(attrs)?.[1])
    const errors = toInt(/errors="(\d+)"/i.exec(attrs)?.[1])
    const sk = toInt(/skipped="(\d+)"/i.exec(attrs)?.[1])
    total += tests
    failed += failures + errors
    skipped += sk
  }
  if (!any) {
    // try root testsuites attrs
    const root = /<testsuites\b([^>]*)>/i.exec(content)
    if (root) {
      const attrs = root[1] || ""
      total = toInt(/tests="(\d+)"/i.exec(attrs)?.[1])
      failed = toInt(/failures="(\d+)"/i.exec(attrs)?.[1]) + toInt(/errors="(\d+)"/i.exec(attrs)?.[1])
      skipped = toInt(/skipped="(\d+)"/i.exec(attrs)?.[1])
      any = true
    }
  }
  if (!any) return null
  passed = Math.max(0, total - failed - skipped)
  const targets: string[] = []
  const nameRe = /<(?:testcase|testsuite)\b[^>]*\b(?:name|file|classname)="([^"]+)"/gi
  let nm: RegExpExecArray | null
  while ((nm = nameRe.exec(content))) {
    if (nm[1]) targets.push(nm[1])
  }
  return { format: "junit", total, passed, failed, skipped, targets: [...new Set(targets)] }
}

export async function readStructuredReport(path: string, format: "json" | "junit" | "auto"): Promise<ParsedReport | null> {
  let content: string
  try {
    content = await readFile(path, "utf8")
  } catch {
    return null
  }
  if (format === "json") return parseJsonReport(content)
  if (format === "junit") return parseJunitReport(content)
  return parseJsonReport(content) ?? parseJunitReport(content)
}
