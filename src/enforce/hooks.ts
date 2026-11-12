import path from "node:path"
import { FileClass, createClassifier } from "../classify/classifier"
import { GitClient } from "../git/repo"
import { CycleStore } from "../store/store"
import { TddState, type TddCycle } from "../types/cycle"
import type { TddConfig } from "../types/config"
import { verifyProtectedTests } from "./checks"

const GIT_MUTATING_SUBCMD = /^(commit|merge|rebase|cherry-pick|reset|restore|checkout|switch|add|apply|amend|stash|clean|rm|mv|worktree|push|pull|fetch)\b/i

function isGitMutatingPart(part: string): boolean {
  const tokens = part.trim().split(/\s+/)
  if (tokens[0] !== "git") return false
  let i = 1
  while (i < tokens.length) {
    const t = tokens[i]!
    if (GIT_MUTATING_SUBCMD.test(t)) return true
    // global options that consume next token
    if (/^(-C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--exec-path|--config-env)$/.test(t)) { i += 2; continue }
    if (/^(-C.+|--git-dir=.+|--work-tree=.+|-c.+)$/.test(t)) { i += 1; continue }
    // other flags
    if (t.startsWith("-")) { i += 1; continue }
    // unknown subcommand
    return false
  }
  return false
}

export interface EnforceContext {
  config: TddConfig
  store: CycleStore
  directory: string
}

function splitShell(cmd: string): string[] {
  // best-effort: split on common command separators/newlines
  return cmd.split(/&&|\|\||;|\n|\r/).map((s) => s.trim()).filter(Boolean)
}

export function isGitMutatingCommand(cmd: string): boolean {
  return splitShell(cmd).some((p) => isGitMutatingPart(p))
}

function abs(directory: string, p: string): string {
  if (!p) return p
  return path.isAbsolute(p) ? path.normalize(p) : path.normalize(path.join(directory, p))
}

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)]
}

function extractPatchTargets(text: string, directory: string): string[] {
  const targets: string[] = []
  for (const m of text.matchAll(/\*\*\* (?:Add|Update|Delete|Move to) File:\s*(.+)/g)) {
    if (m[1]) targets.push(abs(directory, m[1].trim()))
  }
  for (const m of text.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    if (m[1]) targets.push(abs(directory, m[1].trim()))
    if (m[2]) targets.push(abs(directory, m[2].trim()))
  }
  for (const m of text.matchAll(/^rename (?:from|to)\s+(.+)$/gm)) {
    if (m[1]) targets.push(abs(directory, m[1].trim()))
  }
  for (const m of text.matchAll(/^\+\+\+\s+(?:b\/)?(.+)$/gm)) {
    const p = m[1]?.trim()
    if (p && p !== "/dev/null") targets.push(abs(directory, p))
  }
  for (const m of text.matchAll(/^---\s+(?:a\/)?(.+)$/gm)) {
    const p = m[1]?.trim()
    if (p && p !== "/dev/null") targets.push(abs(directory, p))
  }
  return uniq(targets.map((t) => path.normalize(t)))
}

function extractShellWriteTargets(cmd: string, directory: string): { targets: string[]; suspicious: boolean } {
  const targets: string[] = []
  let suspicious = false
  // obvious redirections and in-place edits
  for (const m of cmd.matchAll(/(?:^|[\s;|&])(?:>>?|2>>?|&>>?)\s*([^\s;&|]+)/g)) {
    if (m[1]) targets.push(abs(directory, m[1].replace(/^['"]|['"]$/g, "")))
  }
  // tee can take multiple file args
  for (const m of cmd.matchAll(/\btee\b((?:\s+(?:-[a-zA-Z]+|"[^"]*"|'[^']*'|[^\s;&|]+))*)/g)) {
    const rest = m[1] ?? ""
    for (const tok of rest.trim().split(/\s+/)) {
      if (!tok || tok.startsWith("-")) continue
      targets.push(abs(directory, tok.replace(/^['"]|['"]$/g, "")))
    }
  }
  for (const m of cmd.matchAll(/\bsed\s+-i[^\s]*\s+(?:'[^']*'|"[^"]*"|\S+)\s+([^\s;&|]+)/g)) {
    if (m[1]) targets.push(abs(directory, m[1].replace(/^['"]|['"]$/g, "")))
  }
  for (const m of cmd.matchAll(/\bperl\s+-i[^\s]*\s+-pe?\s+(?:'[^']*'|"[^"]*"|\S+)\s+([^\s;&|]+)/g)) {
    if (m[1]) targets.push(abs(directory, m[1].replace(/^['"]|['"]$/g, "")))
  }
  for (const m of cmd.matchAll(/\b(?:cp|mv)\s+[^\s;&|]+\s+([^\s;&|]+)/g)) {
    // destination may be file or dir; treat as target
    if (m[1]) targets.push(abs(directory, m[1].replace(/^['"]|['"]$/g, "")))
  }

  // programmatic writes that can target arbitrary paths (hard to parse reliably)
  const writeApis = /\b(fs\.(writeFile|appendFile|createWriteStream|rm|unlink|rename|copyFile|mkdir|rmdir|promises\.\w+)|Deno\.(write|remove|rename|mkdir)|open\([^)]*['\"][wax+]|Path\([^)]*\)\.write_text|shutil\.(copy|move|rmtree))\b/i
  if (writeApis.test(cmd)) suspicious = true
  if (/\b(node|python3?|ruby|perl|deno|bun|php)\b.*(-e|--eval|-c|-r)\b/i.test(cmd)) suspicious = true
  if (/\b(cat|tee)\s*<<|\bprintf\b.*>/i.test(cmd) || (/\bcat\b/i.test(cmd) && />/.test(cmd)) || /<<\s*\S+/.test(cmd) && />/.test(cmd)) suspicious = true
  if (/\b(curl|wget)\b[^\n]*(-o|--output|-O)\b/i.test(cmd)) suspicious = true
  if (/\bdd\b[^\n]*\bof=|install\b[^\n]*-m|truncate\b|rsync\b[^\n]*\s+[^\s]+\s+[^\s]+/i.test(cmd)) suspicious = true
  // process substitution / advanced redirection can hide writes
  if (/>\s*\(|<\s*\(/.test(cmd)) suspicious = true

  return { targets: uniq(targets), suspicious }
}

function isStateBlockingWrites(state: TddState): boolean {
  return state === TddState.RED_COMMIT || state === TddState.GREEN_COMMIT || state === TddState.COMPLETE
}

function classifyTargets(
  targets: string[],
  classifier: ReturnType<typeof createClassifier>,
  protectedSet: Set<string>,
) {
  return targets.map((t) => ({ path: t, cls: classifier.classify(t, protectedSet) }))
}

export async function enforceBeforeTool(
  ctx: EnforceContext,
  input: { tool: string; sessionID: string; callID: string },
  output: { args: any },
): Promise<void> {
  const tool = input.tool
  const cycle = await ctx.store.getActive(input.sessionID)
  if (!cycle) return // no active cycle -> do not interfere

  const classifier = createClassifier(
    ctx.config.productionPatterns,
    ctx.config.testPatterns,
    ctx.config.testConfigPatterns,
    ctx.config.excludedPatterns,
    ctx.directory,
  )
  const protectedSet = new Set(Object.keys(cycle.redCommit?.files ?? {}))

  // Subagents and MCP tools are not provably interceptable in child contexts; fail closed at boundary.
  if (tool === "task") {
    throw new Error(
      `TDD enforcement: The task tool is blocked during an active TDD cycle (state ${cycle.state}) because subagent tool activity cannot be reliably intercepted by this plugin. ` +
        `Perform work directly in this session using tdd_* and file tools.`,
    )
  }
  if (tool.startsWith("mcp_") || tool.includes("__") || tool.startsWith("mcp.")) {
    throw new Error(
      `TDD enforcement: MCP/external tools ("${tool}") are blocked during an active TDD cycle (state ${cycle.state}) because their side effects cannot be reliably classified or intercepted. ` +
        `Use built-in intercepted tools or tdd_* tools.`,
    )
  }

  // Shell: block direct git mutations and best-effort file-write bypasses
  if (tool === "shell" || tool === "bash") {
    const cmd = String(output.args?.command ?? "")
    if (isGitMutatingCommand(cmd)) {
      throw new Error(
        `TDD enforcement: Direct git mutation is blocked during an active TDD cycle (state ${cycle.state}). ` +
          `Use the tdd_* tools to create commits and checkpoints.`,
      )
    }
    const { targets, suspicious } = extractShellWriteTargets(cmd, ctx.directory)
    if (targets.length > 0) {
      await enforceFileTargets(ctx, cycle, classifier, protectedSet, targets, "shell")
    } else if (suspicious && !isAllowedShellSuspicious(cycle.state)) {
      throw new Error(
        `TDD enforcement: Shell command appears to perform programmatic file writes in state ${cycle.state}, but target paths cannot be proven safe. ` +
          `Use edit/write tools (intercepted) or a tdd_* tool. Refusing to run command to avoid bypassing enforcement.`,
      )
    }
    return
  }

  // File-modifying tools
  const fileTools = new Set(["edit", "write", "patch", "apply_patch"])
  if (!fileTools.has(tool)) return

  const targets: string[] = []
  const a = output.args ?? {}
  if (typeof a.filePath === "string") targets.push(abs(ctx.directory, a.filePath))
  if (typeof a.path === "string") targets.push(abs(ctx.directory, a.path))
  if (tool === "patch" || tool === "apply_patch") {
    const text = String(a.patchText ?? a.patch ?? a.diff ?? a.input ?? "")
    const extracted = extractPatchTargets(text, ctx.directory)
    targets.push(...extracted)
    // if patch tool provides no parseable targets, fail closed in active cycle
    if (extracted.length === 0 && text.trim().length > 0) {
      throw new Error(
        `TDD enforcement: Cannot determine target files for ${tool} in state ${cycle.state}. Refusing to apply unscoped patch to avoid bypassing enforcement.`,
      )
    }
  }
  if (targets.length === 0) return
  await enforceFileTargets(ctx, cycle, classifier, protectedSet, uniq(targets), tool)
}

function isAllowedShellSuspicious(state: TddState): boolean {
  // even in implementation, opaque programmatic writes can tamper protected files; be strict
  return false
}

async function enforceFileTargets(
  ctx: EnforceContext,
  cycle: TddCycle,
  classifier: ReturnType<typeof createClassifier>,
  protectedSet: Set<string>,
  targets: string[],
  sourceTool: string,
): Promise<void> {
  if (isStateBlockingWrites(cycle.state)) {
    throw new Error(
      `TDD enforcement: File modifications are blocked in state ${cycle.state}. Use the appropriate tdd_* tool to proceed.`,
    )
  }

  const classified = classifyTargets(targets, classifier, protectedSet)

  if (cycle.state === TddState.RED_TEST) {
    for (const { path: t, cls } of classified) {
      if (cls === FileClass.PRODUCTION) {
        throw new Error(
          `TDD enforcement: Production modifications are blocked in RED_TEST. ` +
            `Write a test, execute it, and confirm an expected failure before implementing. Offending file: ${t}`,
        )
      }
    }
    return
  }

  if (cycle.state === TddState.TEST_CORRECTION) {
    for (const { path: t, cls } of classified) {
      if (cls === FileClass.PRODUCTION) {
        throw new Error(
          `TDD enforcement: Production modifications are blocked in TEST_CORRECTION. ` +
            `Correct the test, run it to confirm RED, then amend with tdd_amend_red. Offending file: ${t}`,
        )
      }
    }
    return
  }

  if (cycle.state === TddState.IMPLEMENTATION || cycle.state === TddState.GREEN_VERIFICATION || cycle.state === TddState.REFACTOR_REVIEW) {
    const git = new GitClient(ctx.directory)
    await verifyProtectedTests(git, cycle)
    for (const { path: t, cls } of classified) {
      if (cls === FileClass.PROTECTED_TEST) {
        throw new Error(
          `TDD enforcement: Protected test file "${t}" is locked by RED commit ${cycle.redCommit?.shortSha}. ` +
            `To correct the test, revert implementation with tdd_revert_implementation, then modify and amend with tdd_amend_red.`,
        )
      }
      // fail closed on unclassified/other writes that might be test/prod in unexpected locations? keep permissive for OTHER except protected
      void sourceTool
    }
    return
  }
}
