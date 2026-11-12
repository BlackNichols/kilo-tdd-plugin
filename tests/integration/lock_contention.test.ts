import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { makeTempRepo } from "../helpers/repo"
import { createHarness } from "../helpers/harness"

describe("session locking", () => {
  let repo: Awaited<ReturnType<typeof makeTempRepo>>

  beforeEach(async () => { repo = await makeTempRepo() })
  afterEach(async () => { await repo.cleanup() })

  it("serializes concurrent operations for same session", async () => {
    const h = createHarness(repo.dir, "ses_lock")
    const events: string[] = []
    await Promise.all([
      h.store.withLock("ses_lock", async () => { events.push("a1"); await new Promise(r => setTimeout(r, 50)); events.push("a2") }),
      h.store.withLock("ses_lock", async () => { events.push("b1"); events.push("b2") }),
    ])
    // must not interleave as a1,b1,...
    const idx = (x: string) => events.indexOf(x)
    expect(Math.abs(idx("a1") - idx("a2"))).toBe(1)
    expect(Math.abs(idx("b1") - idx("b2"))).toBe(1)
  })
})
