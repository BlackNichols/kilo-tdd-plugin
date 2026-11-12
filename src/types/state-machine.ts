import { TddState, type TddCycle, type TddLogEntry } from "./cycle"

export type { TddState, TddCycle, TddLogEntry }

/**
 * The only transitions the plugin will ever perform. Every tool consults this
 * table before mutating state, so the agent cannot advance the cycle by any
 * other means.
 */
export const VALID_TRANSITIONS: Readonly<Record<TddState, readonly TddState[]>> = {
  [TddState.IDLE]: [TddState.RED_TEST],
  [TddState.RED_TEST]: [TddState.RED_COMMIT, TddState.IDLE],
  [TddState.RED_COMMIT]: [TddState.IMPLEMENTATION],
  [TddState.IMPLEMENTATION]: [
    TddState.TEST_CORRECTION,
    TddState.GREEN_VERIFICATION,
    TddState.REFACTOR_REVIEW,
  ],
  [TddState.TEST_CORRECTION]: [TddState.RED_COMMIT, TddState.IDLE],
  [TddState.GREEN_VERIFICATION]: [TddState.REFACTOR_REVIEW, TddState.IMPLEMENTATION],
  [TddState.REFACTOR_REVIEW]: [TddState.GREEN_COMMIT, TddState.IMPLEMENTATION],
  [TddState.GREEN_COMMIT]: [TddState.COMPLETE],
  [TddState.COMPLETE]: [TddState.IDLE],
}

/** Tools that are permitted to mutate state. */
export const STATE_MUTATORS: Readonly<Record<TddState, readonly string[]>> = {
  [TddState.IDLE]: ["tdd_start"],
  [TddState.RED_TEST]: ["tdd_commit_red", "tdd_finish"],
  [TddState.RED_COMMIT]: [],
  [TddState.IMPLEMENTATION]: [
    "tdd_revert_implementation",
    "tdd_verify_green",
    "tdd_commit_green",
    "tdd_finish",
  ],
  [TddState.TEST_CORRECTION]: ["tdd_amend_red", "tdd_finish"],
  [TddState.GREEN_VERIFICATION]: ["tdd_verify_green", "tdd_finish"],
  [TddState.REFACTOR_REVIEW]: ["tdd_commit_green", "tdd_finish"],
  [TddState.GREEN_COMMIT]: [],
  [TddState.COMPLETE]: ["tdd_finish"],
}

/**
 * Assert that `from -> to` is a legal transition, throwing a descriptive
 * error otherwise. The error message doubles as the agent-facing explanation
 * of what is required to proceed.
 */
export function requireTransition(from: TddState, to: TddState, tool: string): void {
  const allowed = VALID_TRANSITIONS[from]
  if (!allowed.includes(to)) {
    throw new Error(
      `TDD enforcement: Invalid state transition ${from} -> ${to} from tool "${tool}". ` +
        `From ${from} the only permitted next states are: ${allowed.join(", ")}.`,
    )
  }
}

export function logEntry(
  cycle: TddCycle,
  tool: string,
  action: string,
  ok: boolean,
  detail: string,
): TddLogEntry {
  const entry: TddLogEntry = {
    at: Date.now(),
    state: cycle.state,
    tool,
    action,
    ok,
    detail,
  }
  return entry
}

export function appendLog(cycle: TddCycle, entry: TddLogEntry): void {
  ;(cycle as { log: TddLogEntry[] }).log = [...cycle.log, entry]
}