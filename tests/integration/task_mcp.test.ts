import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { makeTempRepo } from "../helpers/repo"
import { createHarness } from "../helpers/harness"

describe("task/MCP boundary enforcement", () => {
  let repo: Awaited<ReturnType<typeof makeTempRepo>>
  let h: ReturnType<typeof createHarness>

  beforeEach(async () => {
    repo = await makeTempRepo()
    h = createHarness(repo.dir)
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it("blocks task tool during active cycle (subagent cannot be sealed)", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    await expect(h.beforeTool("task", { prompt: "do anything", description: "x", subagent_type: "general" })).rejects.toThrow(/task tool is blocked|subagent/i)
  })

  it("blocks MCP tools during active cycle by default", async () => {
    await h.callTool("tdd_start", { behavior: "x" })
    await expect(h.beforeTool("mcp_filesystem_write_file", { path: "src/x.ts", content: "x" })).rejects.toThrow(/MCP tools are blocked|TDD enforcement/i)
  })

  it("does not block task/MCP when no active cycle", async () => {
    await expect(h.beforeTool("task", { prompt: "x", description: "x", subagent_type: "general" })).resolves.toBeDefined()
  })
})
