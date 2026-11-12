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

export function requireGreenExecution(cycle: TddCycle): TestExecution {
  const ex = cycle.greenExecution
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