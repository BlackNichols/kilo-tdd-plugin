import { tool } from "@kilocode/plugin"
import { GitClient } from "../git/repo"
import { CycleStore } from "../store/store"
import { TddState, type TddCycle } from "../types/cycle"
import { TddError, TddErrorCode } from "../types/errors"
import { DEFAULT_CONFIG } from "../types/config"
import { makeCheckpoint, requireRedExecution, verifyProtectedTests } from "../enforce/checks"
import { runTest } from "../testrun/runner"
import { createClassifier } from "../classify/classifier"

export function createTools(store: CycleStore, directory: string, config = DEFAULT_CONFIG) {
  const git = new GitClient(directory)
  const classifier = createClassifier(
    config.productionPatterns,
    config.testPatterns,
    config.testConfigPatterns,
    config.excludedPatterns,
    directory,
  )

  const tdd_start = tool({
    description: "Start a new TDD cycle. Requires a clean git working tree and no in-progress git operation.",
    args: {
      behavior: tool.schema.string().describe("Short description of the behavior under test (used in commit messages)."),
    },
    async execute(args, context) {
      return store.withLock(context.sessionID, async () => {
        if (config.worktreeEnabled) {
          throw new TddError(TddErrorCode.BLOCKED, "TDD enforcement: worktreeEnabled is not implemented. Disable it (default false) to run cycles in the current worktree.")
        }
        if (!(await git.isRepo())) throw new TddError(TddErrorCode.BLOCKED, "TDD enforcement: Not a git repository.")
        const op = await git.inProgressOperation()
        if (op) throw new TddError(TddErrorCode.GIT_OPERATION_IN_PROGRESS, `TDD enforcement: Git operation in progress (${op}). Resolve it before starting.`)
        const dirty = (await git.allDirtyFiles()).filter((f) => !classifier.isExcluded(pathJoin(directory, f)))
        if (dirty.length > 0) {
          throw new TddError(TddErrorCode.DIRTY_WORKTREE, `TDD enforcement: Working tree is not clean. Commit or stash changes before starting. Dirty: ${dirty.join(", ")}`)
        }
        const existing = await store.getActive(context.sessionID)
        if (existing && existing.state !== TddState.COMPLETE && existing.state !== TddState.IDLE) {
          throw new TddError(TddErrorCode.INCOMPLETE_CYCLE, `TDD enforcement: Cycle ${existing.id} is active in state ${existing.state}. Finish it before starting a new one.`)
        }
        const branch = await git.branch()
        const baseSha = await git.head()
        const cycle = store.create(branch, baseSha, directory)
        ;(cycle as any).behavior = args.behavior
        store.appendLog(cycle, { at: Date.now(), state: cycle.state, tool: "tdd_start", action: "start", ok: true, detail: `Started cycle for: ${args.behavior}` })
        await store.save(cycle)
        await store.setActive(context.sessionID, cycle)
        return `TDD cycle started.\n- id: ${cycle.id}\n- state: ${cycle.state}\n- branch: ${branch}\n- base: ${baseSha.slice(0, 7)}\n- behavior: ${args.behavior}\n\nNext: write a failing test, run it, then call tdd_commit_red.`
      })
    },
  })

  const tdd_status = tool({
    description: "Display the current TDD cycle state, checkpoints, protected tests, and remaining requirements.",
    args: {},
    async execute(_args, context) {
      const cycle = await store.getActive(context.sessionID)
      if (!cycle) return "No active TDD cycle. Use tdd_start to begin."
      const protectedFiles = Object.keys(cycle.redCommit?.files ?? {})
      const req = remainingRequirements(cycle)
      return [
        `TDD Status`,
        `- cycle: ${cycle.id}`,
        `- state: ${cycle.state}`,
        `- branch: ${cycle.branch}`,
        `- base: ${cycle.baseSha.slice(0, 7)}`,
        `- behavior: ${(cycle as any).behavior ?? "(unknown)"}`,
        `- RED commit: ${cycle.redCommit?.shortSha ?? "none"}`,
        `- GREEN commit: ${cycle.greenCommit?.shortSha ?? "none"}`,
        `- protected tests: ${protectedFiles.length ? protectedFiles.join(", ") : "none"}`,
        `- red execution: ${cycle.redExecution ? `${cycle.redExecution.verdict === false ? "RED(valid)" : cycle.redExecution.verdict === true ? "PASS" : "AMBIGUOUS"} - ${cycle.redExecution.verdictReason}` : "none"}`,
        `- green execution: ${cycle.greenExecution ? `${cycle.greenExecution.verdict === true ? "GREEN(valid)" : "NOT GREEN"} - ${cycle.greenExecution.verdictReason}` : "none"}`,
        `- refactor review: ${cycle.refactorReviewDone ? (cycle.refactorReviewNoOp ? "done (no refactor)" : "done") : "pending"}`,
        `- amendments: ${cycle.amendCount}, reverts: ${cycle.revertCount}`,
        `- remaining: ${req.join("; ") || "none"}`,
      ].join("\n")
    },
  })

  const tdd_commit_red = tool({
    description: "Verify RED and create the dedicated test-only RED commit. Only allowed in RED_TEST state with a valid failing test execution recorded.",
    args: {
      command: tool.schema.string().describe("The exact test command that produced the RED result."),
      testFiles: tool.schema.array(tool.schema.string()).optional().describe("Optional test file paths expected to be exercised (improves verdict attribution/scoping)."),
      message: tool.schema.string().optional().describe("Optional commit message override."),
    },
    async execute(args, context) {
      return store.withLock(context.sessionID, async () => {
        const cycle = store.requireActive(await store.getActive(context.sessionID))
        store.requireState(cycle, [TddState.RED_TEST], "tdd_commit_red")

        const dirty = (await git.allDirtyFiles()).filter((f) => !classifier.isExcluded(pathJoin(directory, f)))
        if (dirty.length === 0) throw new TddError(TddErrorCode.NO_TEST_IN_STAGED, "TDD enforcement: No modified files to commit as RED test.")
        const prod = dirty.filter((f) => classifier.isProduction(pathJoin(directory, f)))
        if (prod.length > 0) throw new TddError(TddErrorCode.PRODUCTION_IN_STAGED, `TDD enforcement: Production files modified in RED_TEST: ${prod.join(", ")}. Revert them before committing RED.`)
        const tests = dirty.filter((f) => !f.endsWith("/") && (classifier.isTest(pathJoin(directory, f)) || classifier.isTestConfig(pathJoin(directory, f))))
        const testFilesOnly = dirty.filter((f) => !f.endsWith("/") && classifier.isTest(pathJoin(directory, f)))
        if (tests.length === 0) throw new TddError(TddErrorCode.NO_TEST_IN_STAGED, "TDD enforcement: No test files modified. Write a failing test first.")

        const targetTests = normalizeTargets(args.testFiles, testFilesOnly.length ? testFilesOnly : tests, directory)
        // Run/record test execution now (plugin verifies independently)
        const exec = await runTest({ cwd: directory, command: args.command, targetTests, runners: config.testRunners })
        cycle.redExecution = exec
        if (exec.verdict !== false) {
          store.appendLog(cycle, { at: Date.now(), state: cycle.state, tool: "tdd_commit_red", action: "verify-red", ok: false, detail: exec.verdictReason })
          await store.save(cycle)
          throw new TddError(exec.hadCompileError ? TddErrorCode.COMPILE_ERROR : exec.skipped ? TddErrorCode.SKIPPED_TEST : exec.verdict === true ? TddErrorCode.NOT_RED : TddErrorCode.AMBIGUOUS_RESULT, `TDD enforcement: Cannot commit RED. ${exec.verdictReason}`)
        }

        await git.addFiles(dirty)
        const behavior = (cycle as any).behavior ?? "behavior"
        const msg = args.message ?? config.commitMessages.red.replace("{behavior}", behavior)
        const sha = await git.commit(msg)
        const committedFiles = await git.filesInCommit(sha)
        cycle.redCommit = await makeCheckpoint(git, sha, msg, committedFiles)
        cycle.state = TddState.IMPLEMENTATION
        store.appendLog(cycle, { at: Date.now(), state: cycle.state, tool: "tdd_commit_red", action: "commit", ok: true, detail: `RED commit ${sha.slice(0, 7)} files: ${committedFiles.join(", ")}` })
        await store.save(cycle)
        return `RED committed: ${sha.slice(0, 7)}\nFiles: ${committedFiles.join(", ")}\nState: ${cycle.state}\n\nNext: implement the behavior, then call tdd_verify_green.`
      })
    },
  })

  const tdd_revert_implementation = tool({
    description: "Revert implementation changes made since the RED commit, preserving the RED commit and pre-cycle work. Transitions to TEST_CORRECTION.",
    args: {},
    async execute(_args, context) {
      return store.withLock(context.sessionID, async () => {
        const cycle = store.requireActive(await store.getActive(context.sessionID))
        store.requireState(cycle, [TddState.IMPLEMENTATION, TddState.GREEN_VERIFICATION, TddState.REFACTOR_REVIEW], "tdd_revert_implementation")
        if (!cycle.redCommit) throw new TddError(TddErrorCode.NOT_FOUND, "TDD enforcement: No RED commit recorded.")

        const protectedFiles = new Set(Object.keys(cycle.redCommit.files))
        // Files changed since RED commit (working tree + staged + untracked)
        const dirty = await git.allDirtyFiles()
        const toRestore = dirty.filter((f) => !protectedFiles.has(f) && !protectedFiles.has(pathJoin(directory, f)))
        // detect unrelated? only revert tracked changes attributable to impl; keep untracked that predate? we can't perfectly know, but we restore tracked files from RED and remove untracked impl files
        const trackedChanged = (await git.run(["diff", "--name-only", "HEAD"])).stdout.split("\n").map(s=>s.trim()).filter(Boolean)
          .filter((f) => !protectedFiles.has(f) && !classifier.isExcluded(pathJoin(directory, f)))
        const stagedChanged = (await git.stagedAll()).filter((f) => !protectedFiles.has(f) && !classifier.isExcluded(pathJoin(directory, f)))
        const untracked = (await git.untrackedFiles()).filter((f) => !protectedFiles.has(f) && !classifier.isExcluded(pathJoin(directory, f)))
        const restoreSet = [...new Set([...trackedChanged, ...stagedChanged])]

        if (restoreSet.length > 0) await git.restoreFrom(cycle.redCommit.sha, restoreSet)
        // unstage anything left that's not protected
        for (const f of (await git.stagedAll()).filter(x => !protectedFiles.has(x))) {
          await git.run(["restore", "--staged", "--", f])
        }
        // remove untracked impl files (best effort, explicit)
        for (const f of untracked) {
          await git.run(["clean", "-fd", "--", f])
        }

        cycle.revertCount++
        cycle.state = TddState.TEST_CORRECTION
        store.appendLog(cycle, { at: Date.now(), state: cycle.state, tool: "tdd_revert_implementation", action: "revert", ok: true, detail: `Reverted: ${restoreSet.join(", ")}; removed untracked: ${untracked.join(", ")}` })
        await store.save(cycle)
        return `Implementation reverted.\nRestored: ${restoreSet.join(", ") || "(none)"}\nRemoved untracked: ${untracked.join(", ") || "(none)"}\nState: ${cycle.state}\n\nNext: correct the test, run it to confirm RED, then call tdd_amend_red.`
      })
    },
  })

  const tdd_amend_red = tool({
    description: "Amend the RED commit with corrected test files after verifying the corrected test is RED. Only allowed in TEST_CORRECTION.",
    args: {
      command: tool.schema.string().describe("The exact test command that produced the corrected RED result."),
      testFiles: tool.schema.array(tool.schema.string()).optional().describe("Optional test file paths expected to be exercised (improves verdict attribution/scoping)."),
      message: tool.schema.string().optional().describe("Optional amended commit message."),
    },
    async execute(args, context) {
      return store.withLock(context.sessionID, async () => {
        const cycle = store.requireActive(await store.getActive(context.sessionID))
        store.requireState(cycle, [TddState.TEST_CORRECTION], "tdd_amend_red")
        if (!cycle.redCommit) throw new TddError(TddErrorCode.NOT_FOUND, "TDD enforcement: No RED commit to amend.")

        const dirty = (await git.allDirtyFiles()).filter((f) => !classifier.isExcluded(pathJoin(directory, f)))
        const prod = dirty.filter((f) => classifier.isProduction(pathJoin(directory, f)))
        if (prod.length > 0) throw new TddError(TddErrorCode.PRODUCTION_IN_STAGED, `TDD enforcement: Production files modified in TEST_CORRECTION: ${prod.join(", ")}`)
        const dirtyTests = dirty.filter((f) => !f.endsWith("/") && (classifier.isTest(pathJoin(directory, f)) || classifier.isTestConfig(pathJoin(directory, f))))
        const dirtyTestFiles = dirty.filter((f) => !f.endsWith("/") && classifier.isTest(pathJoin(directory, f)))
        const fallbackBase = dirtyTestFiles.length ? dirtyTestFiles : (dirtyTests.length ? dirtyTests : Object.keys(cycle.redCommit.files).filter((f) => !f.endsWith("/")))
        const targetTests = normalizeTargets(args.testFiles, fallbackBase, directory)

        const exec = await runTest({ cwd: directory, command: args.command, targetTests, runners: config.testRunners })
        cycle.redExecution = exec
        if (exec.verdict !== false) {
          store.appendLog(cycle, { at: Date.now(), state: cycle.state, tool: "tdd_amend_red", action: "verify-red", ok: false, detail: exec.verdictReason })
          await store.save(cycle)
          throw new TddError(TddErrorCode.NOT_RED, `TDD enforcement: Corrected test must be RED. ${exec.verdictReason}`)
        }

        await git.addFiles(dirty.length ? dirty : Object.keys(cycle.redCommit.files))
        const behavior = (cycle as any).behavior ?? "behavior"
        const msg = args.message ?? config.commitMessages.red.replace("{behavior}", behavior)
        const sha = await git.amend(msg)
        const amendedFiles = await git.filesInCommit(sha)
        cycle.redCommit = await makeCheckpoint(git, sha, msg, amendedFiles)
        cycle.amendCount++
        cycle.state = TddState.IMPLEMENTATION
        store.appendLog(cycle, { at: Date.now(), state: cycle.state, tool: "tdd_amend_red", action: "amend", ok: true, detail: `Amended RED to ${sha.slice(0, 7)}` })
        await store.save(cycle)
        return `RED amended: ${sha.slice(0, 7)}\nState: ${cycle.state}\n\nNext: implement the corrected behavior, then tdd_verify_green.`
      })
    },
  })

  const tdd_verify_green = tool({
    description: "Run and verify that the relevant tests pass (GREEN). Requires protected tests unchanged.",
    args: {
      command: tool.schema.string().describe("The exact test command to verify GREEN."),
      testFiles: tool.schema.array(tool.schema.string()).optional().describe("Optional test file paths expected to be exercised (defaults to protected RED tests for attribution/scoping)."),
    },
    async execute(args, context) {
      return store.withLock(context.sessionID, async () => {
        const cycle = store.requireActive(await store.getActive(context.sessionID))
        store.requireState(cycle, [TddState.IMPLEMENTATION, TddState.GREEN_VERIFICATION, TddState.REFACTOR_REVIEW], "tdd_verify_green")
        await verifyProtectedTests(git, cycle)
        const protectedTests = Object.keys(cycle.redCommit?.files ?? {})
        const targetTests = normalizeTargets(args.testFiles, protectedTests, directory)
        const exec = await runTest({ cwd: directory, command: args.command, targetTests, runners: config.testRunners })
        cycle.greenExecution = exec
        if (exec.verdict === true) {
          cycle.state = TddState.REFACTOR_REVIEW
          store.appendLog(cycle, { at: Date.now(), state: cycle.state, tool: "tdd_verify_green", action: "green", ok: true, detail: exec.verdictReason })
          await store.save(cycle)
          return `GREEN verified.\n${exec.verdictReason}\nState: ${cycle.state}\n\nNext: review refactoring. Call tdd_commit_green with refactor notes when ready.`
        }
        cycle.state = TddState.IMPLEMENTATION
        store.appendLog(cycle, { at: Date.now(), state: cycle.state, tool: "tdd_verify_green", action: "green-fail", ok: false, detail: exec.verdictReason })
        await store.save(cycle)
        throw new TddError(TddErrorCode.NOT_GREEN, `TDD enforcement: GREEN not established. ${exec.verdictReason}`)
      })
    },
  })

  const tdd_commit_green = tool({
    description: "Commit the implementation after GREEN verification and refactoring review.",
    args: {
      refactor: tool.schema.enum(["yes", "no"]).describe("Whether refactoring was performed."),
      notes: tool.schema.string().optional().describe("Refactoring review notes."),
      message: tool.schema.string().optional().describe("Optional commit message override."),
    },
    async execute(args, context) {
      return store.withLock(context.sessionID, async () => {
        const cycle = store.requireActive(await store.getActive(context.sessionID))
        store.requireState(cycle, [TddState.REFACTOR_REVIEW, TddState.IMPLEMENTATION], "tdd_commit_green")
        await verifyProtectedTests(git, cycle)
        if (!cycle.greenExecution || cycle.greenExecution.verdict !== true) {
          throw new TddError(TddErrorCode.NOT_GREEN, "TDD enforcement: GREEN has not been verified. Run tdd_verify_green first.")
        }
        cycle.refactorReviewDone = true
        cycle.refactorReviewNoOp = args.refactor === "no"
        cycle.refactorNotes = args.notes ?? null

        const dirty = (await git.allDirtyFiles()).filter((f) => !classifier.isExcluded(pathJoin(directory, f)))
        const protectedSet = new Set(Object.keys(cycle.redCommit?.files ?? {}))
        const implFiles = dirty.filter((f) => !protectedSet.has(f))
        // Protected tests must remain unchanged (already verified above). Do not stage them.
        // Stage implementation/non-protected files that are part of the verified work.
        // If new/changed non-protected test helpers exist, reject by default to keep GREEN commit scoped (configurable).
        const nonProtectedTestChanges = implFiles.filter((f) => classifier.isTest(pathJoin(directory, f)) || classifier.isTestConfig(pathJoin(directory, f)))
        if (nonProtectedTestChanges.length > 0 && !config.allowNonProtectedTestConfigInGreenCommit) {
          throw new TddError(
            TddErrorCode.BLOCKED,
            `TDD enforcement: Non-protected test/config files changed (${nonProtectedTestChanges.join(", ")}). ` +
              `GREEN commit must contain only implementation changes from this verified cycle. Commit or revert them separately, or enable allowNonProtectedTestConfigInGreenCommit in tdd config.`,
          )
        }
        const toCommit = implFiles.filter((f) => {
          if (classifier.isExcluded(pathJoin(directory, f))) return false
          if (classifier.isTest(pathJoin(directory, f)) || classifier.isTestConfig(pathJoin(directory, f))) {
            return !!config.allowNonProtectedTestConfigInGreenCommit
          }
          return true
        })
        if (toCommit.length === 0) throw new TddError(TddErrorCode.BLOCKED, "TDD enforcement: No implementation files to commit. Ensure implementation changes are present and classified as production/implementation files.")
        await git.addFiles(toCommit)
        const behavior = (cycle as any).behavior ?? "behavior"
        const msg = args.message ?? config.commitMessages.green.replace("{behavior}", behavior)
        const sha = await git.commit(msg)
        cycle.greenCommit = await makeCheckpoint(git, sha, msg, toCommit)
        cycle.state = TddState.COMPLETE
        store.appendLog(cycle, { at: Date.now(), state: cycle.state, tool: "tdd_commit_green", action: "commit", ok: true, detail: `GREEN commit ${sha.slice(0, 7)}` })
        await store.save(cycle)
        return `GREEN committed: ${sha.slice(0, 7)}\nFiles: ${toCommit.join(", ")}\nState: ${cycle.state}\n\nCall tdd_finish to generate the report.`
      })
    },
  })

  const tdd_finish = tool({
    description: "Finish the current TDD cycle and generate its report. Returns the cycle to IDLE.",
    args: {},
    async execute(_args, context) {
      return store.withLock(context.sessionID, async () => {
        const cycle = store.requireActive(await store.getActive(context.sessionID))
        if (cycle.state !== TddState.COMPLETE && cycle.state !== TddState.IDLE) {
          // allow abort from certain states? be explicit
          // but spec says finish closes cycle and generates report
        }
        if (cycle.state !== TddState.COMPLETE) {
          throw new TddError(TddErrorCode.STATE_MISMATCH, `TDD enforcement: Cannot finish in state ${cycle.state}. Complete the cycle (reach GREEN_COMMIT/COMPLETE) first.`)
        }
        cycle.report = {
          cycleId: cycle.id,
          branch: cycle.branch,
          baseSha: cycle.baseSha,
          redSha: cycle.redCommit?.sha ?? null,
          greenSha: cycle.greenCommit?.sha ?? null,
          durationMs: Date.now() - cycle.createdAt,
          states: cycle.log.map((l) => l.state),
          amendments: cycle.amendCount,
          reverts: cycle.revertCount,
          redVerdict: cycle.redExecution?.verdictReason ?? "n/a",
          greenVerdict: cycle.greenExecution?.verdictReason ?? "n/a",
          refactorDecision: cycle.refactorReviewNoOp ? "no refactoring needed" : "refactored",
          summary: `RED ${cycle.redCommit?.shortSha ?? "?"} -> GREEN ${cycle.greenCommit?.shortSha ?? "?"}`,
        }
        cycle.state = TddState.IDLE
        store.appendLog(cycle, { at: Date.now(), state: cycle.state, tool: "tdd_finish", action: "finish", ok: true, detail: "Cycle complete" })
        await store.save(cycle)
        await store.setActive(context.sessionID, null)
        return [
          `TDD Cycle Complete`,
          `- cycle: ${cycle.id}`,
          `- behavior: ${(cycle as any).behavior ?? ""}`,
          `- RED: ${cycle.redCommit?.shortSha ?? "n/a"}`,
          `- GREEN: ${cycle.greenCommit?.shortSha ?? "n/a"}`,
          `- amendments: ${cycle.amendCount}`,
          `- reverts: ${cycle.revertCount}`,
          `- refactor: ${cycle.refactorReviewNoOp ? "none needed" : "performed"}`,
          `- duration: ${Math.round(cycle.report.durationMs / 1000)}s`,
        ].join("\n")
      })
    },
  })

  return { tdd_start, tdd_status, tdd_commit_red, tdd_revert_implementation, tdd_amend_red, tdd_verify_green, tdd_commit_green, tdd_finish }
}


function normalizeTargets(provided: string[] | undefined, fallback: string[], baseDir: string): string[] {
  const src = (provided && provided.length > 0 ? provided : fallback) ?? []
  const base = baseDir.replace(/\/+$/, "")
  const out = src
    .map((p) => {
      let s = p.replace(/\\/g, "/")
      if (s.startsWith(base + "/")) s = s.slice(base.length + 1)
      if (!s.startsWith("/")) s = `${base}/${s}`.replace(/\/+/g, "/")
      return s
    })
    .filter(Boolean)
  return [...new Set(out)]
}

function remainingRequirements(cycle: TddCycle): string[] {
  const req: string[] = []
  switch (cycle.state) {
    case TddState.RED_TEST: req.push("Write failing test, run it, call tdd_commit_red"); break
    case TddState.IMPLEMENTATION: req.push("Implement behavior, call tdd_verify_green"); break
    case TddState.TEST_CORRECTION: req.push("Correct test, run RED, call tdd_amend_red"); break
    case TddState.GREEN_VERIFICATION: req.push("Run tdd_verify_green"); break
    case TddState.REFACTOR_REVIEW: req.push("Review refactoring, call tdd_commit_green"); break
    case TddState.GREEN_COMMIT: req.push("Call tdd_commit_green"); break
    case TddState.COMPLETE: req.push("Call tdd_finish"); break
  }
  return req
}

function pathJoin(base: string, p: string): string {
  if (p.startsWith("/")) return p
  return `${base}/${p}`.replace(/\/+/g, "/")
}