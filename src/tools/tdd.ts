import { tool } from "@kilocode/plugin"
import { GitClient } from "../git/repo"
import { CycleStore } from "../store/store"
import { TddState, type TddCycle } from "../types/cycle"
import { TddError, TddErrorCode } from "../types/errors"
import { DEFAULT_CONFIG } from "../types/config"
import { makeCheckpoint, requireRedExecution, requireFullGreenCoverage, verifyProtectedTests, getRequiredRedTestFiles, getCoveredRedTestFiles } from "../enforce/checks"
import { runTest } from "../testrun/runner"
import { createClassifier } from "../classify/classifier"

export function createTools(store: CycleStore, directory: string, config = DEFAULT_CONFIG, configSource = "defaults") {
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
        return `TDD cycle started.\n- id: ${cycle.id}\n- state: ${cycle.state}\n- branch: ${branch}\n- base: ${baseSha.slice(0, 7)}\n- behavior: ${args.behavior}\n- config: ${configSource}\n\nNext: write a failing test, run it, then call tdd_commit_red.`
      })
    },
  })

  const tdd_status = tool({
    description: "Display the current TDD cycle state, checkpoints, protected tests, and remaining requirements.",
    args: {},
    async execute(_args, context) {
      const cycle = await store.getActive(context.sessionID)
      if (!cycle) return `No active TDD cycle. Use tdd_start to begin.\n- config: ${configSource}`
      const protectedFiles = Object.keys(cycle.redCommit?.files ?? {})
      const requiredRedTests = getRequiredRedTestFiles(cycle, directory, config)
      const coveredRedTests = getCoveredRedTestFiles(cycle, directory, config)
      const missingRedTests = requiredRedTests.filter((f) => !coveredRedTests.includes(f))
      const req = remainingRequirements(cycle, missingRedTests)
      const greenRuns = cycle.greenExecutions ?? []
      return [
        `TDD Status`,
        `- cycle: ${cycle.id}`,
        `- state: ${cycle.state}`,
        `- branch: ${cycle.branch}`,
        `- base: ${cycle.baseSha.slice(0, 7)}`,
        `- behavior: ${(cycle as any).behavior ?? "(unknown)"}`,
        `- config: ${configSource}`,
        `- RED commit: ${cycle.redCommit?.shortSha ?? "none"}`,
        `- GREEN commit: ${cycle.greenCommit?.shortSha ?? "none"}`,
        `- protected tests: ${protectedFiles.length ? protectedFiles.join(", ") : "none"}`,
        `- required RED tests: ${requiredRedTests.length ? requiredRedTests.join(", ") : "none"}`,
        `- GREEN-covered RED tests: ${coveredRedTests.length ? coveredRedTests.join(", ") : "none"}`,
        `- missing GREEN coverage: ${missingRedTests.length ? missingRedTests.join(", ") : "none"}`,
        `- impl snapshots: ${(cycle.implSnapshots ?? []).length ? (cycle.implSnapshots ?? []).map((s) => `${s.id}:${s.shortSha}`).join(", ") : "none"}`,
        `- red execution: ${cycle.redExecution ? `${cycle.redExecution.verdict === false ? "RED(valid)" : cycle.redExecution.verdict === true ? "PASS" : "AMBIGUOUS"} - ${cycle.redExecution.verdictReason}` : "none"}`,
        `- green executions: ${greenRuns.length ? greenRuns.map((e) => `${e.verdict === true ? "GREEN" : "NOT_GREEN"}(${e.command})`).join(" | ") : "none"}`,
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
        const prod = dirty.filter((f) => {
          const p = pathJoin(directory, f)
          return classifier.isProduction(p) && !classifier.isTest(p) && !classifier.isTestConfig(p)
        })
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
        const snapshotFiles = [...new Set([...restoreSet, ...untracked])]

        let snapshot: { sha: string; shortSha: string } | null = null
        if (snapshotFiles.length > 0) {
          const snapSha = await git.createDetachedSnapshot("HEAD", snapshotFiles, `tdd-snapshot: ${cycle.id} revert ${cycle.revertCount + 1}`)
          if (snapSha) {
            snapshot = { sha: snapSha, shortSha: await git.shortSha(snapSha) }
            if (!cycle.implSnapshots) cycle.implSnapshots = []
            cycle.implSnapshots.push({
              id: String(cycle.implSnapshots.length + 1),
              sha: snapSha,
              shortSha: snapshot.shortSha,
              baseSha: cycle.redCommit.sha,
              files: snapshotFiles,
              createdAt: Date.now(),
              reason: "revert",
            })
          }
        }

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
        cycle.greenExecutions = []
        cycle.state = TddState.TEST_CORRECTION
        store.appendLog(cycle, { at: Date.now(), state: cycle.state, tool: "tdd_revert_implementation", action: "revert", ok: true, detail: `Snapshot: ${snapshot?.shortSha ?? "none"}; reverted: ${restoreSet.join(", ")}; removed untracked: ${untracked.join(", ")}` })
        await store.save(cycle)
        return `Implementation reverted.\nSnapshot: ${snapshot ? `${snapshot.shortSha} (${snapshot.sha})` : "(none - no implementation changes detected)"}\nRestored: ${restoreSet.join(", ") || "(none)"}\nRemoved untracked: ${untracked.join(", ") || "(none)"}\nState: ${cycle.state}\n\nNext: correct the test, run it to confirm RED, then call tdd_amend_red. After amend, you can restore saved implementation with tdd_restore_implementation.`
      })
    },
  })

  const tdd_restore_implementation = tool({
    description: "Restore implementation from a detached-commit snapshot created by tdd_revert_implementation. Only allowed in IMPLEMENTATION state (after test correction/amend). Uses 3-way apply; on conflict the restore is aborted and the snapshot remains available.",
    args: {
      snapshotId: tool.schema.string().optional().describe("Snapshot id to restore (defaults to latest)."),
    },
    async execute(args, context) {
      return store.withLock(context.sessionID, async () => {
        const cycle = store.requireActive(await store.getActive(context.sessionID))
        store.requireState(cycle, [TddState.IMPLEMENTATION, TddState.GREEN_VERIFICATION], "tdd_restore_implementation")
        await verifyProtectedTests(git, cycle)
        const snaps = cycle.implSnapshots ?? []
        if (snaps.length === 0) throw new TddError(TddErrorCode.NOT_FOUND, "TDD enforcement: No implementation snapshot available to restore.")
        const snap = args.snapshotId ? snaps.find((s) => s.id === args.snapshotId || s.shortSha === args.snapshotId || s.sha === args.snapshotId) : snaps[snaps.length - 1]
        if (!snap) throw new TddError(TddErrorCode.NOT_FOUND, `TDD enforcement: Snapshot "${args.snapshotId}" not found. Available: ${snaps.map((s) => `${s.id}:${s.shortSha}`).join(", ")}`)
        const blob = await git.run(["cat-file", "-t", snap.sha])
        if (blob.exitCode !== 0 || blob.stdout.trim() !== "commit") {
          throw new TddError(TddErrorCode.PERSISTENCE_ERROR, `TDD enforcement: Snapshot commit ${snap.shortSha} no longer exists; cannot restore.`)
        }
        const applied = await git.applyCommit3Way(snap.sha)
        if (!applied.ok) {
          store.appendLog(cycle, { at: Date.now(), state: cycle.state, tool: "tdd_restore_implementation", action: "restore", ok: false, detail: `Conflict/failed applying ${snap.shortSha}: ${applied.output}` })
          await store.save(cycle)
          throw new TddError(
            TddErrorCode.BLOCKED,
            `TDD enforcement: Could not restore snapshot ${snap.shortSha} cleanly (3-way apply conflict/failure). Snapshot remains available for manual recovery.\n${applied.output || ""}`.trim(),
            { snapshot: snap.shortSha, conflicts: applied.conflicts },
          )
        }
        store.appendLog(cycle, { at: Date.now(), state: cycle.state, tool: "tdd_restore_implementation", action: "restore", ok: true, detail: `Restored snapshot ${snap.shortSha}` })
        await store.save(cycle)
        return `Implementation restored from snapshot ${snap.shortSha} (${snap.sha}).\nFiles: ${snap.files.join(", ") || "(unknown)"}\n\nReview restored changes, adjust if needed for the amended test, then call tdd_verify_green.`
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
        const prod = dirty.filter((f) => {
          const p = pathJoin(directory, f)
          return classifier.isProduction(p) && !classifier.isTest(p) && !classifier.isTestConfig(p)
        })
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
        cycle.greenExecutions = []
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
        const requiredRedTests = getRequiredRedTestFiles(cycle, directory, config)
        const protectedTests = Object.keys(cycle.redCommit?.files ?? {})
        const fallbackTargets = requiredRedTests.length ? requiredRedTests : protectedTests
        let targetTests: string[]
        let explicitScope = false
        if (args.testFiles && args.testFiles.length > 0) {
          targetTests = normalizeTargets(args.testFiles, fallbackTargets, directory)
          explicitScope = true
        } else {
          const mentioned = fallbackTargets.filter((f) => commandMentionsFile(args.command, f, directory))
          if (mentioned.length > 0) {
            targetTests = normalizeTargets(mentioned, fallbackTargets, directory)
            explicitScope = mentioned.length < fallbackTargets.length || mentioned.length === 1
          } else {
            targetTests = normalizeTargets(fallbackTargets, fallbackTargets, directory)
            explicitScope = false
          }
        }
        const exec = await runTest({ cwd: directory, command: args.command, targetTests, runners: config.testRunners })
        const relDir = directory.replace(/\\/g, "/").replace(/\/+$/, "")
        const toRel = (f: string) => {
          let s = f.replace(/\\/g, "/")
          if (s.startsWith(relDir + "/")) s = s.slice(relDir.length + 1)
          return s.replace(/^\.\/+/, "")
        }
        const attributedNow = new Set((exec.attributedFiles ?? []).map(toRel))
        // allow scoped runs to attribute their intended targets when verdict is unambiguously GREEN
        if (exec.verdict === true && explicitScope) {
          for (const t of targetTests) {
            const rel = toRel(t)
            if (requiredRedTests.includes(rel)) attributedNow.add(rel)
          }
          ;(exec as any).attributedFiles = [...attributedNow]
        }
        const intendedRequired = requiredRedTests.filter((f) => targetTests.some((t) => toRel(t) === f || t.endsWith("/" + f) || t === f))
        const missingAttributed = intendedRequired.filter((f) => !attributedNow.has(f))
        if (exec.verdict === true && missingAttributed.length > 0) {
          // fail closed: green run cannot prove coverage for intended required targets
          execVerdictOverride(exec, null, `${exec.verdictReason} Cannot attribute GREEN coverage to required test(s): ${missingAttributed.join(", ")}. Provide explicit testFiles/structured report or a scoped command whose output references them.`)
        }
        if (!cycle.greenExecutions) cycle.greenExecutions = []
        cycle.greenExecutions.push(exec)
        if (exec.verdict === true) {
          const covered = getCoveredRedTestFiles(cycle, directory, config)
          const missing = requiredRedTests.filter((f) => !covered.includes(f))
          if (missing.length > 0) {
            cycle.state = TddState.GREEN_VERIFICATION
            store.appendLog(cycle, { at: Date.now(), state: cycle.state, tool: "tdd_verify_green", action: "green-partial", ok: true, detail: `${exec.verdictReason}; missing coverage: ${missing.join(", ")}` })
            await store.save(cycle)
            return `GREEN verified for this command.\n${exec.verdictReason}\nCovered RED tests: ${covered.join(", ") || "(none)"}\nMissing RED tests: ${missing.join(", ")}\nState: ${cycle.state}\n\nRun tdd_verify_green for remaining test scopes/commands until all RED tests are covered, then review refactoring and call tdd_commit_green.`
          }
          cycle.state = TddState.REFACTOR_REVIEW
          store.appendLog(cycle, { at: Date.now(), state: cycle.state, tool: "tdd_verify_green", action: "green", ok: true, detail: exec.verdictReason })
          await store.save(cycle)
          return `GREEN verified for all required RED tests.\n${exec.verdictReason}\nCovered RED tests: ${covered.join(", ") || "(none)"}\nState: ${cycle.state}\n\nNext: review refactoring. Call tdd_commit_green with refactor notes when ready.`
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
        requireFullGreenCoverage(cycle, directory, config)
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
          greenVerdict: (cycle.greenExecutions ?? []).filter((e) => e.verdict === true).map((e) => e.verdictReason).join(" | ") || "n/a",
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

  return { tdd_start, tdd_status, tdd_commit_red, tdd_revert_implementation, tdd_restore_implementation, tdd_amend_red, tdd_verify_green, tdd_commit_green, tdd_finish }
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

function remainingRequirements(cycle: TddCycle, missingGreen: string[] = []): string[] {
  const req: string[] = []
  switch (cycle.state) {
    case TddState.RED_TEST: req.push("Write failing test, run it, call tdd_commit_red"); break
    case TddState.IMPLEMENTATION: req.push("Implement behavior, call tdd_verify_green for all RED tests"); break
    case TddState.TEST_CORRECTION: req.push("Correct test, run RED, call tdd_amend_red"); break
    case TddState.GREEN_VERIFICATION: req.push(missingGreen.length ? `Run tdd_verify_green for missing RED tests: ${missingGreen.join(", ")}` : "Run tdd_verify_green for remaining RED tests"); break
    case TddState.REFACTOR_REVIEW: req.push("Review refactoring, call tdd_commit_green"); break
    case TddState.GREEN_COMMIT: req.push("Call tdd_commit_green"); break
    case TddState.COMPLETE: req.push("Call tdd_finish"); break
  }
  return req
}

function execVerdictOverride(exec: any, verdict: boolean | null, reason: string) {
  exec.verdict = verdict
  exec.verdictReason = reason
}

function pathJoin(base: string, p: string): string {
  if (p.startsWith("/")) return p
  return `${base}/${p}`.replace(/\/+/g, "/")
}

function commandMentionsFile(command: string, file: string, baseDir: string): boolean {
  const rel = file.replace(/\\/g, "/").replace(/^\.\/+/, "")
  if (command.includes(rel)) return true
  const abs = rel.startsWith("/") ? rel : pathJoin(baseDir, rel)
  if (command.includes(abs)) return true
  const base = rel.split("/").pop() ?? rel
  if (base && command.includes(base)) return true
  return false
}