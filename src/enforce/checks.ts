import crypto from "node:crypto"
import path from "node:path"
import { GitClient } from "../git/repo"
import { TddState, type TddCycle, type Checkpoint, type TestExecution } from "../types/cycle"
import { TddError, TddErrorCode } from "../types/errors"

export async function makeCheckpoint(
  git: GitClient,
  sha: string,
  message: string,
  files: string[],
): Promise<Checkpoint> {
  const fileHashes = await git.hashCommitFiles(sha, files)
  const contentHash = crypto
    .createHash("sha256")
    .update(files.sort().join("\n") + "\n" + JSON.stringify(fileHashes))
    .digest("hex")
  return {
    sha,
    shortSha: await git.shortSha(sha),
    message,
    files: fileHashes,
    contentHash,
    committedAt: Date.now(),
  }
}

export async function verifyProtectedTests(
  git: GitClient,
  cycle: TddCycle,
): Promise<void> {
  if (!cycle.redCommit) return
  const missing: string[] = []
  const changed: string[] = []
  for (const file of Object.keys(cycle.redCommit.files)) {
    const blob = await git.blobSha("HEAD", file)
    if (!blob) {
      // also check working tree existence
      missing.push(file)
      continue
    }
    const expected = cycle.redCommit.files[file]
    if (blob !== expected) changed.push(file)
  }
  // also compare working tree content hash vs committed
  for (const file of Object.keys(cycle.redCommit.files)) {
    if (missing.includes(file) || changed.includes(file)) continue
    try {
      const current = await git.hashWorkingFile(path.isAbsolute(file) ? file : path.join(git.cwd, file))
      const headContent = await git.run(["show", `HEAD:${file}`])
      if (headContent.exitCode === 0) {
        const headHash = crypto.createHash("sha256").update(headContent.stdout).digest("hex")
        if (current !== headHash) changed.push(file)
      }
    } catch {
      // file may be missing on disk
    }
  }
  const uniqMissing = [...new Set(missing)]
  const uniqChanged = [...new Set(changed)]
  if (uniqMissing.length > 0) {
    throw new TddError(
      TddErrorCode.PROTECTED_TEST_DELETED,
      `TDD enforcement: Protected test file(s) deleted: ${uniqMissing.join(", ")}. ` +
        `These are locked by RED commit ${cycle.redCommit.shortSha}.`,
      { files: uniqMissing },
    )
  }
  if (uniqChanged.length > 0) {
    throw new TddError(
      TddErrorCode.PROTECTED_TEST_MODIFIED,
      `TDD enforcement: Protected test file(s) modified: ${uniqChanged.join(", ")}. ` +
        `These are locked by RED commit ${cycle.redCommit.shortSha}. ` +
        `To correct the test, use tdd_revert_implementation then modify and run tdd_amend_red.`,
      { files: uniqChanged },
    )
  }
}

export function requireRedExecution(cycle: TddCycle): TestExecution {
  const ex = cycle.redExecution
  if (!ex) {
    throw new TddError(
      TddErrorCode.NO_RECENT_EXECUTION,
      "TDD enforcement: No test execution recorded. Run the relevant test and confirm it fails (RED) before proceeding.",
    )
  }
  if (ex.hadCompileError) {
    throw new TddError(TddErrorCode.COMPILE_ERROR, `TDD enforcement: ${ex.verdictReason}`)
  }
  if (ex.skipped) {
    throw new TddError(TddErrorCode.SKIPPED_TEST, `TDD enforcement: ${ex.verdictReason}`)
  }
  if (ex.verdict === true) {
    throw new TddError(
      TddErrorCode.NOT_RED,
      "TDD enforcement: The recorded test passed. A valid RED requires the relevant test to fail due to missing/incorrect behavior.",
    )
  }
  if (ex.verdict !== false) {
    throw new TddError(TddErrorCode.AMBIGUOUS_RESULT, `TDD enforcement: ${ex.verdictReason}`)
  }
  return ex
}

import { createClassifier } from "../classify/classifier"
import { DEFAULT_CONFIG } from "../types/config"
import type { TddConfig } from "../types/config"

function relPath(p: string, cwd: string): string {
  const n = p.replace(/\\/g, "/").replace(/\/+/g, "/")
  const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "") + "/"
  if (n.startsWith(base)) return n.slice(base.length)
  return n.replace(/^\.\/+/, "")
}

export function getRequiredRedTestFiles(cycle: TddCycle, directory: string, config: TddConfig = DEFAULT_CONFIG): string[] {
  const classifier = createClassifier(
    config.productionPatterns,
    config.testPatterns,
    config.testConfigPatterns,
    config.excludedPatterns,
    directory,
  )
  const files = Object.keys(cycle.redCommit?.files ?? {})
  return files.filter((f) => !f.endsWith("/") && classifier.isTest(path.isAbsolute(f) ? f : path.join(directory, f)))
}

export function getCoveredRedTestFiles(cycle: TddCycle, directory: string, config: TddConfig = DEFAULT_CONFIG): string[] {
  const required = new Set(getRequiredRedTestFiles(cycle, directory, config))
  const covered = new Set<string>()
  for (const ex of cycle.greenExecutions ?? []) {
    if (ex.verdict !== true) continue
    const evidenced = (ex.attributedFiles && ex.attributedFiles.length > 0) ? ex.attributedFiles : []
    for (const tf of evidenced) {
      const rel = relPath(tf, directory)
      if (required.has(rel)) covered.add(rel)
      if (required.has(tf)) covered.add(tf)
    }
  }
  return [...covered]
}

export function requireFullGreenCoverage(cycle: TddCycle, directory: string, config: TddConfig = DEFAULT_CONFIG): void {
  const required = getRequiredRedTestFiles(cycle, directory, config)
  if (required.length === 0) {
    // fallback to legacy: need at least one green
    const anyGreen = (cycle.greenExecutions ?? []).some((e) => e.verdict === true)
    if (!anyGreen) throw new TddError(TddErrorCode.NOT_GREEN, "TDD enforcement: GREEN has not been verified. Run tdd_verify_green first.")
    return
  }
  const covered = new Set(getCoveredRedTestFiles(cycle, directory, config))
  const missing = required.filter((f) => !covered.has(f))
  const anyGreen = (cycle.greenExecutions ?? []).some((e) => e.verdict === true)
  if (!anyGreen) {
    throw new TddError(TddErrorCode.NOT_GREEN, "TDD enforcement: GREEN has not been verified. Run tdd_verify_green first.")
  }
  if (missing.length > 0) {
    throw new TddError(
      TddErrorCode.NOT_GREEN,
      `TDD enforcement: Not all RED test files are verified GREEN. Missing coverage for: ${missing.join(", ")}. ` +
        `Run tdd_verify_green for each remaining test scope/command so all protected RED tests are covered.`,
      { missing },
    )
  }
}

export function requireGreenExecution(cycle: TddCycle): TestExecution {
  const ex = (cycle.greenExecutions ?? []).find((e) => e.verdict === true)
  if (!ex) {
    throw new TddError(
      TddErrorCode.NO_RECENT_EXECUTION,
      "TDD enforcement: No GREEN verification recorded. Run tdd_verify_green after implementing.",
    )
  }
  if (ex.skipped) {
    throw new TddError(TddErrorCode.SKIPPED_TEST, `TDD enforcement: ${ex.verdictReason}`)
  }
  if (ex.verdict !== true) {
    throw new TddError(TddErrorCode.NOT_GREEN, `TDD enforcement: ${ex.verdictReason}`)
  }
  return ex
}