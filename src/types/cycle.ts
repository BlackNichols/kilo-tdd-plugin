/**
 * The TDD cycle state machine.
 *
 * Transitions are driven exclusively by the custom tools exposed by this
 * plugin. The agent cannot advance the state by editing files or running
 * arbitrary Git commands — only the plugin's own tool implementations may
 * mutate `CycleStore.state`.
 */
export const TddState = {
  IDLE: "IDLE",
  RED_TEST: "RED_TEST",
  RED_COMMIT: "RED_COMMIT",
  IMPLEMENTATION: "IMPLEMENTATION",
  TEST_CORRECTION: "TEST_CORRECTION",
  GREEN_VERIFICATION: "GREEN_VERIFICATION",
  REFACTOR_REVIEW: "REFACTOR_REVIEW",
  GREEN_COMMIT: "GREEN_COMMIT",
  COMPLETE: "COMPLETE",
} as const

export type TddState = (typeof TddState)[keyof typeof TddState]

/**
 * Result of executing a test, as observed by the plugin.
 *
 * We deliberately do NOT trust exit codes alone. The plugin requires an
 * explicit, structured observation of the test run so that an agent cannot
 * fabricate a GREEN result by editing a test, skipping it, or claiming a
 * pass it never observed.
 */
export interface TestExecution {
  /** Absolute path to the test file(s) that were executed. */
  readonly testFiles: readonly string[]
  /** Command that was run, e.g. `vitest run src/foo.test.ts`. */
  readonly command: string
  /** Raw stdout captured from the run. */
  readonly stdout: string
  /** Raw stderr captured from the run. */
  readonly stderr: string
  /** Process exit code. */
  readonly exitCode: number
  /** Unix timestamp (ms) when the run finished. */
  readonly finishedAt: number
  /** Duration in milliseconds. */
  readonly durationMs: number
  /**
   * Parsed verdict. `true` only when the plugin observed a genuine pass for
   * the target test(s). `false` only when it observed a genuine failure
   * attributable to missing behavior. `null` when the result is ambiguous
   * (compile error, infrastructure failure, skipped test, no target test
   * found, etc.).
   */
  readonly verdict: boolean | null
  /** Human-readable explanation of the verdict. */
  readonly verdictReason: string
  /** Names of the target test cases, if identifiable in output. */
  readonly targetTests?: readonly string[]
  /** Whether any target test was skipped rather than run. */
  readonly skipped: boolean
  /** Whether the run contained compilation or build errors. */
  readonly hadCompileError: boolean
}

/**
 * A single Git commit that serves as a TDD checkpoint.
 */
export interface Checkpoint {
  /** Full 40-char commit SHA. */
  readonly sha: string
  /** Short (7+ char) SHA for display. */
  readonly shortSha: string
  /** Commit message. */
  readonly message: string
  /** Files committed at this checkpoint, mapped to their blob SHA. */
  readonly files: Readonly<Record<string, string>>
  /** Cryptographic hash (SHA-256) of the committed content, for integrity. */
  readonly contentHash: string
  /** Unix timestamp (ms) when the commit was created. */
  readonly committedAt: number
}

/**
 * Full record of an active or completed TDD cycle.
 *
 * Persisted to `.kilo/tdd/cycles/<id>.json` so the state survives across
 * model switches, session compaction, and Agent Manager handoffs.
 */
export interface TddCycle {
  readonly id: string
  readonly createdAt: number
  readonly updatedAt: number
  state: TddState
  /** Branch the cycle started on. */
  readonly branch: string
  /** SHA of the commit the cycle started from. */
  readonly baseSha: string
  /** Working directory the cycle was started in. */
  readonly directory: string
  /** RED checkpoint, once committed. */
  redCommit: Checkpoint | null
  /** Latest verified RED execution. */
  redExecution: TestExecution | null
  /** Latest verified GREEN execution. */
  greenExecution: TestExecution | null
  /** Whether the refactoring review has been explicitly declared complete. */
  refactorReviewDone: boolean
  /** Whether the refactoring review declared no refactoring necessary. */
  refactorReviewNoOp: boolean
  /** Free-text notes from the refactoring review. */
  refactorNotes: string | null
  /** Final GREEN checkpoint, once committed. */
  greenCommit: Checkpoint | null
  /** Number of RED amendments performed during this cycle. */
  amendCount: number
  /** Number of implementation reverts performed during this cycle. */
  revertCount: number
  /** Full audit log of plugin actions. Mutated in place by the store. */
  log: TddLogEntry[]
  /** Human-readable report generated at COMPLETE. */
  report: TddReport | null
}

export interface TddLogEntry {
  readonly at: number
  readonly state: TddState
  readonly tool: string
  readonly action: string
  readonly ok: boolean
  readonly detail: string
}

export interface TddReport {
  readonly cycleId: string
  readonly branch: string
  readonly baseSha: string
  readonly redSha: string | null
  readonly greenSha: string | null
  readonly durationMs: number
  readonly states: readonly string[]
  readonly amendments: number
  readonly reverts: number
  readonly redVerdict: string
  readonly greenVerdict: string
  readonly refactorDecision: string
  readonly summary: string
}