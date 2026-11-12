import { mkdir, readFile, rename, writeFile, rm, open } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { TddState, type TddCycle, type TddLogEntry } from "../types/cycle"
import { TddError, TddErrorCode } from "../types/errors"
import { GitClient } from "../git/repo"

const locks = new Map<string, Promise<void>>()

async function withMemoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  let release: () => void = () => {}
  const next = new Promise<void>((r) => (release = r))
  const chain = prev.then(() => next)
  locks.set(key, chain)
  await prev
  try {
    return await fn()
  } finally {
    release()
    if (locks.get(key) === chain) locks.delete(key)
  }
}

async function atomicWrite(file: string, data: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${process.pid}.${randomUUID()}`
  await writeFile(tmp, data, "utf8")
  await rename(tmp, file)
}

export class CycleStore {
  constructor(readonly root: string) {}

  private dir() {
    return path.join(this.root, ".kilo", "tdd")
  }

  private cyclePath(id: string) {
    return path.join(this.dir(), "cycles", `${id}.json`)
  }

  private activePath(sessionId: string) {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")
    return path.join(this.dir(), "active", `${safe}.json`)
  }

  private lockPath(sessionId: string) {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")
    return path.join(this.dir(), "locks", `${safe}.lock`)
  }

  async withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return withMemoryLock(sessionId, async () => {
      const lockFile = this.lockPath(sessionId)
      await mkdir(path.dirname(lockFile), { recursive: true })
      const deadline = Date.now() + 10_000
      let fh: Awaited<ReturnType<typeof open>> | null = null
      while (Date.now() < deadline) {
        try {
          // 'wx' = fail if exists (best-effort cross-process lock)
          fh = await open(lockFile, "wx")
          await fh.writeFile(`${process.pid}\n${Date.now()}\n`, "utf8")
          break
        } catch (e: any) {
          if (e?.code !== "EEXIST") throw e
          // stale lock recovery: if older than 60s, remove and retry
          try {
            const raw = await readFile(lockFile, "utf8")
            const ts = Number(raw.split("\n")[1] || 0)
            if (ts && Date.now() - ts > 60_000) {
              await rm(lockFile, { force: true })
              continue
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 50))
        }
      }
      if (!fh) {
        throw new TddError(TddErrorCode.CONCURRENT_CALL, `TDD enforcement: Could not acquire session lock for ${sessionId}. Another operation may be in progress.`)
      }
      try {
        return await fn()
      } finally {
        try { await fh.close() } catch {}
        try { await rm(lockFile, { force: true }) } catch {}
      }
    })
  }

  async getActive(sessionId: string): Promise<TddCycle | null> {
    try {
      const raw = await readFile(this.activePath(sessionId), "utf8")
      const { cycleId } = JSON.parse(raw) as { cycleId: string }
      if (!cycleId) return null
      const cycle = await this.get(cycleId)
      if (!cycle) return null
      await this.reconcile(cycle)
      return cycle
    } catch (e) {
      if (e instanceof TddError) throw e
      return null
    }
  }

  async get(cycleId: string): Promise<TddCycle | null> {
    try {
      const raw = await readFile(this.cyclePath(cycleId), "utf8")
      return JSON.parse(raw) as TddCycle
    } catch {
      return null
    }
  }

  /**
   * Verify persisted state against git/filesystem reality. Fail closed on
   * mismatch rather than guessing — recovery requires manual intervention.
   */
  async reconcile(cycle: TddCycle): Promise<void> {
    if (cycle.state === TddState.IDLE || cycle.state === TddState.COMPLETE) return
    const git = new GitClient(this.root)
    if (!(await git.isRepo())) {
      throw new TddError(TddErrorCode.PERSISTENCE_ERROR, `TDD enforcement: Active cycle ${cycle.id} but directory is not a git repository. Manual recovery required.`)
    }
    const op = await git.inProgressOperation()
    if (op) {
      throw new TddError(
        TddErrorCode.GIT_OPERATION_IN_PROGRESS,
        `TDD enforcement: Git operation in progress (${op}) while cycle ${cycle.id} is active (state ${cycle.state}). ` +
          `This may indicate a crash mid-operation. Resolve git state (complete/abort the operation) before continuing; do not auto-repair.`,
      )
    }
    if (cycle.redCommit) {
      const blob = await git.run(["cat-file", "-t", cycle.redCommit.sha])
      if (blob.exitCode !== 0 || blob.stdout.trim() !== "commit") {
        throw new TddError(TddErrorCode.PERSISTENCE_ERROR, `TDD enforcement: RED commit ${cycle.redCommit.shortSha} (${cycle.redCommit.sha}) no longer exists. Cycle ${cycle.id} is inconsistent; manual recovery required.`)
      }
      // verify protected files still exist in HEAD with recorded blob SHAs
      for (const [file, expectedBlob] of Object.entries(cycle.redCommit.files)) {
        const headBlob = await git.blobSha("HEAD", file)
        if (headBlob && headBlob !== expectedBlob) {
          // allowed only if we are in TEST_CORRECTION and HEAD moved? but HEAD shouldn't change there
          // or if amended: redCommit.sha/files should have been updated. Mismatch = tamper/inconsistency.
          if (cycle.state !== TddState.TEST_CORRECTION) {
            throw new TddError(TddErrorCode.INTEGRITY_CHECK_FAILED, `TDD enforcement: Protected test "${file}" in HEAD does not match recorded RED baseline. Cycle ${cycle.id} is inconsistent/tampered; manual recovery required.`, { file, expectedBlob, headBlob })
          }
        }
      }
    } else if (cycle.state !== TddState.RED_TEST) {
      throw new TddError(TddErrorCode.PERSISTENCE_ERROR, `TDD enforcement: Cycle ${cycle.id} in state ${cycle.state} but no RED commit recorded. Manual recovery required.`)
    }
    if (cycle.greenCommit) {
      const blob = await git.run(["cat-file", "-t", cycle.greenCommit.sha])
      if (blob.exitCode !== 0) {
        throw new TddError(TddErrorCode.PERSISTENCE_ERROR, `TDD enforcement: GREEN commit ${cycle.greenCommit.shortSha} no longer exists. Cycle ${cycle.id} inconsistent; manual recovery required.`)
      }
    }
  }

  async save(cycle: TddCycle): Promise<void> {
    ;(cycle as any).updatedAt = Date.now()
    await atomicWrite(this.cyclePath(cycle.id), JSON.stringify(cycle, null, 2))
  }

  async setActive(sessionId: string, cycle: TddCycle | null): Promise<void> {
    const p = this.activePath(sessionId)
    await mkdir(path.dirname(p), { recursive: true })
    if (!cycle) {
      await atomicWrite(p, JSON.stringify({ cycleId: null }))
      return
    }
    if (cycle.state === TddState.IDLE) {
      await atomicWrite(p, JSON.stringify({ cycleId: null }))
      return
    }
    await atomicWrite(p, JSON.stringify({ cycleId: cycle.id }))
  }

  create(branch: string, baseSha: string, directory: string): TddCycle {
    const now = Date.now()
    const id = randomUUID()
    return {
      id,
      createdAt: now,
      updatedAt: now,
      state: TddState.RED_TEST,
      branch,
      baseSha,
      directory,
      redCommit: null,
      redExecution: null,
      greenExecution: null,
      refactorReviewDone: false,
      refactorReviewNoOp: false,
      refactorNotes: null,
      greenCommit: null,
      amendCount: 0,
      revertCount: 0,
      log: [],
      report: null,
    }
  }

  appendLog(cycle: TddCycle, entry: TddLogEntry): void {
    cycle.log.push(entry)
  }

  requireActive(cycle: TddCycle | null): TddCycle {
    if (!cycle) {
      throw new TddError(
        TddErrorCode.NOT_FOUND,
        "TDD enforcement: No active TDD cycle. Start one with tdd_start.",
      )
    }
    return cycle
  }

  requireState(cycle: TddCycle, allowed: TddState[], tool: string): void {
    if (!allowed.includes(cycle.state)) {
      throw new TddError(
        TddErrorCode.STATE_MISMATCH,
        `TDD enforcement: "${tool}" is not allowed in state ${cycle.state}. ` +
          `Allowed states: ${allowed.join(", ")}.`,
        { state: cycle.state, allowed },
      )
    }
  }
}
