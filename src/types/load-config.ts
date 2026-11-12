import { readFile } from "node:fs/promises"
import path from "node:path"
import { DEFAULT_CONFIG, type CommitMessages, type TddConfig, type TestRunnerConfig } from "./config"
import { TddError, TddErrorCode } from "./errors"

type PartialConfig = Record<string, unknown>

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function expectStringArray(name: string, v: unknown): string[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.trim().length > 0)) {
    throw new TddError(TddErrorCode.BLOCKED, `TDD config: "${name}" must be an array of non-empty strings.`)
  }
  return v as string[]
}

function expectBoolean(name: string, v: unknown): boolean | undefined {
  if (v === undefined) return undefined
  if (typeof v !== "boolean") throw new TddError(TddErrorCode.BLOCKED, `TDD config: "${name}" must be a boolean.`)
  return v
}

function expectCommitMessages(v: unknown): CommitMessages | undefined {
  if (v === undefined) return undefined
  if (!isObject(v)) throw new TddError(TddErrorCode.BLOCKED, `TDD config: "commitMessages" must be an object.`)
  const o = v
  for (const k of ["red", "green", "refactor"] as const) {
    if (o[k] !== undefined && typeof o[k] !== "string") {
      throw new TddError(TddErrorCode.BLOCKED, `TDD config: "commitMessages.${k}" must be a string.`)
    }
  }
  return {
    red: typeof o.red === "string" ? o.red : DEFAULT_CONFIG.commitMessages.red,
    green: typeof o.green === "string" ? o.green : DEFAULT_CONFIG.commitMessages.green,
    refactor: typeof o.refactor === "string" ? o.refactor : DEFAULT_CONFIG.commitMessages.refactor,
  }
}

function expectEnum<T extends string>(name: string, v: unknown, allowed: readonly T[]): T | undefined {
  if (v === undefined) return undefined
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw new TddError(TddErrorCode.BLOCKED, `TDD config: "${name}" must be one of: ${allowed.join(", ")}.`)
  }
  return v as T
}

function parseTestRunners(v: unknown, base: readonly TestRunnerConfig[]): TestRunnerConfig[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v)) throw new TddError(TddErrorCode.BLOCKED, `TDD config: "testRunners" must be an array.`)
  const out: TestRunnerConfig[] = []
  for (let i = 0; i < v.length; i++) {
    const item = v[i]
    if (!isObject(item)) throw new TddError(TddErrorCode.BLOCKED, `TDD config: "testRunners[${i}]" must be an object.`)
    const id = item.id
    if (typeof id !== "string" || !id.trim()) throw new TddError(TddErrorCode.BLOCKED, `TDD config: "testRunners[${i}].id" must be a non-empty string.`)
    const existing = base.find((r) => r.id === id)
    const match = item.match === undefined
      ? existing?.match
      : Array.isArray(item.match) && item.match.every((x) => typeof x === "string" && x.length > 0)
        ? (item.match as string[])
        : null
    if (!match) throw new TddError(TddErrorCode.BLOCKED, `TDD config: "testRunners[${i}].match" must be an array of strings${existing ? " (or omitted to inherit)" : ""}.`)
    const command = item.command === undefined ? existing?.command : typeof item.command === "string" ? item.command : null
    if (item.command !== undefined && command === null) throw new TddError(TddErrorCode.BLOCKED, `TDD config: "testRunners[${i}].command" must be a string.`)
    let skipIndicator: RegExp | undefined = existing?.skipIndicator
    if (item.skipIndicator !== undefined) {
      if (typeof item.skipIndicator !== "string") throw new TddError(TddErrorCode.BLOCKED, `TDD config: "testRunners[${i}].skipIndicator" must be a regex string.`)
      try {
        skipIndicator = new RegExp(item.skipIndicator, "i")
      } catch {
        throw new TddError(TddErrorCode.BLOCKED, `TDD config: "testRunners[${i}].skipIndicator" is not a valid regular expression.`)
      }
    }
    let scopeArgs = existing?.scopeArgs
    if (item.scopeArgs !== undefined) {
      if (!Array.isArray(item.scopeArgs) || !item.scopeArgs.every((x) => typeof x === "string")) {
        throw new TddError(TddErrorCode.BLOCKED, `TDD config: "testRunners[${i}].scopeArgs" must be an array of strings (prefix tokens; target files are appended).`)
      }
      const prefix = item.scopeArgs as string[]
      scopeArgs = (files) => [...prefix, ...files]
    }
    if (!scopeArgs) {
      // default for custom runners: append files
      scopeArgs = (files) => [...files]
    }
    const buildCommand = item.buildCommand === undefined ? existing?.buildCommand : expectBoolean(`testRunners[${i}].buildCommand`, item.buildCommand)
    const reportFormat = item.reportFormat === undefined
      ? existing?.reportFormat
      : (item.reportFormat === "json" || item.reportFormat === "junit" || item.reportFormat === "auto" ? item.reportFormat : null)
    if (item.reportFormat !== undefined && reportFormat === null) {
      throw new TddError(TddErrorCode.BLOCKED, `TDD config: "testRunners[${i}].reportFormat" must be one of: json, junit, auto.`)
    }
    let reportArgs = existing?.reportArgs
    if (item.reportArgs !== undefined) {
      if (!Array.isArray(item.reportArgs) || !item.reportArgs.every((x) => typeof x === "string")) {
        throw new TddError(TddErrorCode.BLOCKED, `TDD config: "testRunners[${i}].reportArgs" must be an array of strings.`)
      }
      reportArgs = item.reportArgs as string[]
    }
    out.push({
      id, match, scopeArgs,
      ...(command ? { command } : {}),
      ...(buildCommand !== undefined ? { buildCommand } : {}),
      ...(reportFormat ? { reportFormat } : {}),
      ...(reportArgs ? { reportArgs } : {}),
      ...(skipIndicator ? { skipIndicator } : {}),
    })
  }
  return out
}

export function mergeConfig(base: TddConfig, partial: PartialConfig | null | undefined): TddConfig {
  if (!isObject(partial)) return base
  const allowed = new Set([
    "productionPatterns", "testPatterns", "testConfigPatterns", "excludedPatterns",
    "commitMessages", "worktreeEnabled", "refactorMandatory", "logLevel", "strictness", "testRunners",
    "allowNonProtectedTestConfigInGreenCommit",
  ])
  for (const k of Object.keys(partial)) {
    if (!allowed.has(k)) {
      throw new TddError(TddErrorCode.BLOCKED, `TDD config: unknown key "${k}".`)
    }
  }
  const cm = expectCommitMessages(partial.commitMessages)
  const logLevel = expectEnum("logLevel", partial.logLevel, ["debug", "info", "warn", "error"] as const) ?? base.logLevel
  const strictness = expectEnum("strictness", partial.strictness, ["strict", "lenient"] as const) ?? base.strictness
  const testRunners = parseTestRunners(partial.testRunners, base.testRunners) ?? base.testRunners
  return {
    ...base,
    productionPatterns: expectStringArray("productionPatterns", partial.productionPatterns) ?? base.productionPatterns,
    testPatterns: expectStringArray("testPatterns", partial.testPatterns) ?? base.testPatterns,
    testConfigPatterns: expectStringArray("testConfigPatterns", partial.testConfigPatterns) ?? base.testConfigPatterns,
    excludedPatterns: expectStringArray("excludedPatterns", partial.excludedPatterns) ?? base.excludedPatterns,
    commitMessages: cm ? { ...base.commitMessages, ...cm } : base.commitMessages,
    worktreeEnabled: expectBoolean("worktreeEnabled", partial.worktreeEnabled) ?? base.worktreeEnabled,
    refactorMandatory: expectBoolean("refactorMandatory", partial.refactorMandatory) ?? base.refactorMandatory,
    logLevel,
    strictness,
    testRunners,
    allowNonProtectedTestConfigInGreenCommit:
      expectBoolean("allowNonProtectedTestConfigInGreenCommit", partial.allowNonProtectedTestConfigInGreenCommit) ??
      base.allowNonProtectedTestConfigInGreenCommit,
  }
}

function stripJsonComments(raw: string): string {
  // best-effort: remove /* */ and // comments not inside strings (simple heuristic)
  let out = ""
  let i = 0
  let inStr: string | null = null
  let esc = false
  while (i < raw.length) {
    const ch = raw[i]!
    const next = raw[i + 1]
    if (inStr) {
      out += ch
      if (esc) esc = false
      else if (ch === "\\") esc = true
      else if (ch === inStr) inStr = null
      i++
      continue
    }
    if (ch === '"' || ch === "'") { inStr = ch; out += ch; i++; continue }
    if (ch === "/" && next === "/") { while (i < raw.length && raw[i] !== "\n") i++; continue }
    if (ch === "/" && next === "*") { i += 2; while (i + 1 < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++; i += 2; continue }
    out += ch
    i++
  }
  return out
}

export async function loadConfig(directory: string): Promise<TddConfig> {
  const candidates = ["kilo.json", "kilo.jsonc", path.join(".kilo", "config.json")]
  let lastError: unknown = null
  for (const rel of candidates) {
    try {
      const raw = await readFile(path.join(directory, rel), "utf8")
      const stripped = stripJsonComments(raw)
      const parsed = JSON.parse(stripped) as any
      const pluginCfg = parsed?.tdd ?? parsed?.pluginConfig?.["kilo-tdd-plugin"] ?? parsed?.["kilo-tdd-plugin"] ?? null
      if (pluginCfg == null) continue
      if (!isObject(pluginCfg)) throw new TddError(TddErrorCode.BLOCKED, `TDD config in ${rel} must be an object.`)
      return mergeConfig(DEFAULT_CONFIG, pluginCfg)
    } catch (e) {
      if ((e as any)?.code === "ENOENT") continue
      lastError = e
      // if file exists but config is invalid, fail closed
      if (e instanceof TddError) throw e
      if (e instanceof SyntaxError) throw new TddError(TddErrorCode.BLOCKED, `TDD config parse error in ${rel}: ${e.message}`)
      // other read errors: try next? but likely real problem
      if ((e as any)?.code) continue
      throw e
    }
  }
  if (lastError instanceof TddError) throw lastError
  return DEFAULT_CONFIG
}
