/**
 * TDD enforcement error.
 *
 * Carries a stable `code` so callers can branch on the reason, and a
 * human-readable `message` suitable for display to the agent.
 */
export class TddError extends Error {
  constructor(
    readonly code: TddErrorCode,
    message: string,
    /** Additional structured context, e.g. the offending file or commit SHA. */
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = "TddError"
  }
}

export const TddErrorCode = {
  // Pre-cycle
  STATE_MISMATCH: "STATE_MISMATCH",
  DIRTY_WORKTREE: "DIRTY_WORKTREE",
  GIT_OPERATION_IN_PROGRESS: "GIT_OPERATION_IN_PROGRESS",
  INCOMPLETE_CYCLE: "INCOMPLETE_CYCLE",
  // RED
  NO_RECENT_EXECUTION: "NO_RECENT_EXECUTION",
  NOT_RED: "NOT_RED",
  AMBIGUOUS_RESULT: "AMBIGUOUS_RESULT",
  COMPILE_ERROR: "COMPILE_ERROR",
  INFRASTRUCTURE_ERROR: "INFRASTRUCTURE_ERROR",
  SKIPPED_TEST: "SKIPPED_TEST",
  NO_TARGET_TEST: "NO_TARGET_TEST",
  // Checkpoints
  PRODUCTION_IN_STAGED: "PRODUCTION_IN_STAGED",
  NO_TEST_IN_STAGED: "NO_TEST_IN_STAGED",
  PROTECTED_TEST_MODIFIED: "PROTECTED_TEST_MODIFIED",
  PROTECTED_TEST_DELETED: "PROTECTED_TEST_DELETED",
  UNRELATED_CHANGES: "UNRELATED_CHANGES",
  // Correction
  IMPLEMENTATION_NOT_REVERTED: "IMPLEMENTATION_NOT_REVERTED",
  // Green
  NOT_GREEN: "NOT_GREEN",
  // Integrity
  INTEGRITY_CHECK_FAILED: "INTEGRITY_CHECK_FAILED",
  // Persistence
  PERSISTENCE_ERROR: "PERSISTENCE_ERROR",
  CONCURRENT_CALL: "CONCURRENT_CALL",
  // Generic
  BLOCKED: "BLOCKED",
  NOT_FOUND: "NOT_FOUND",
  INTERNAL: "INTERNAL",
} as const

export type TddErrorCode = (typeof TddErrorCode)[keyof typeof TddErrorCode]