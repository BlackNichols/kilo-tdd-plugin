import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadConfig, loadConfigWithSource, mergeConfig } from "../../src/types/load-config"
import { DEFAULT_CONFIG } from "../../src/types/config"
import { TddError } from "../../src/types/errors"

describe("loadConfig / mergeConfig", () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "kilo-tdd-cfg-")) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it("returns defaults when no config file exists", async () => {
    const cfg = await loadConfig(dir)
    expect(cfg.strictness).toBe(DEFAULT_CONFIG.strictness)
    expect(cfg.testPatterns).toEqual(DEFAULT_CONFIG.testPatterns)
    expect(cfg.allowNonProtectedTestConfigInGreenCommit).toBe(false)
  })

  it("loads and merges tdd config from kilo.json", async () => {
    await writeFile(path.join(dir, "kilo.json"), JSON.stringify({ tdd: { strictness: "lenient", refactorMandatory: false, commitMessages: { red: "red: {behavior}" }, allowNonProtectedTestConfigInGreenCommit: true } }))
    const cfg = await loadConfig(dir)
    expect(cfg.strictness).toBe("lenient")
    expect(cfg.refactorMandatory).toBe(false)
    expect(cfg.commitMessages.red).toBe("red: {behavior}")
    expect(cfg.commitMessages.green).toBe(DEFAULT_CONFIG.commitMessages.green)
    expect(cfg.allowNonProtectedTestConfigInGreenCommit).toBe(true)
  })

  it("supports pluginConfig key", async () => {
    await writeFile(path.join(dir, "kilo.json"), JSON.stringify({ pluginConfig: { "kilo-tdd-plugin": { logLevel: "debug" } } }))
    const cfg = await loadConfig(dir)
    expect(cfg.logLevel).toBe("debug")
  })

  it("supports .kilo/config.json", async () => {
    await mkdir(path.join(dir, ".kilo"), { recursive: true })
    await writeFile(path.join(dir, ".kilo", "config.json"), JSON.stringify({ tdd: { productionPatterns: ["app/**"] } }))
    const cfg = await loadConfig(dir)
    expect(cfg.productionPatterns).toEqual(["app/**"])
  })

  it("loads plugin-owned .kilo/tdd.json and reports source", async () => {
    await mkdir(path.join(dir, ".kilo"), { recursive: true })
    await writeFile(path.join(dir, ".kilo", "tdd.json"), JSON.stringify({ excludedPatterns: ["my-artifacts/**"] }))
    const loaded = await loadConfigWithSource(dir)
    expect(loaded.config.excludedPatterns).toEqual(["my-artifacts/**"])
    expect(loaded.source).toBe(path.join(".kilo", "tdd.json"))
  })

  it("loads plugin-owned kilo.tdd.json", async () => {
    await writeFile(path.join(dir, "kilo.tdd.json"), JSON.stringify({ strictness: "lenient" }))
    const loaded = await loadConfigWithSource(dir)
    expect(loaded.config.strictness).toBe("lenient")
    expect(loaded.source).toBe("kilo.tdd.json")
  })

  it("prefers plugin-owned config over host config block", async () => {
    await mkdir(path.join(dir, ".kilo"), { recursive: true })
    await writeFile(path.join(dir, ".kilo", "tdd.json"), JSON.stringify({ strictness: "lenient" }))
    await writeFile(path.join(dir, "kilo.json"), JSON.stringify({ tdd: { strictness: "strict" } }))
    const loaded = await loadConfigWithSource(dir)
    expect(loaded.config.strictness).toBe("lenient")
    expect(loaded.source).toBe(path.join(".kilo", "tdd.json"))
  })

  it("throws on invalid config types", async () => {
    await writeFile(path.join(dir, "kilo.json"), JSON.stringify({ tdd: { strictness: "maybe" } }))
    await expect(loadConfig(dir)).rejects.toBeInstanceOf(TddError)
  })

  it("throws on unknown keys (schema validation)", async () => {
    await writeFile(path.join(dir, "kilo.json"), JSON.stringify({ tdd: { unknownThing: true } }))
    await expect(loadConfig(dir)).rejects.toThrow(/unknown key/)
  })

  it("allows overriding/adding testRunners including build/report fields", async () => {
    await writeFile(path.join(dir, "kilo.json"), JSON.stringify({ tdd: { testRunners: [{ id: "node", match: ["node --test"], command: "node --test", buildCommand: true, reportFormat: "junit", reportArgs: ["--junit={file}"], scopeArgs: ["--test"] }] } }))
    const cfg = await loadConfig(dir)
    expect(cfg.testRunners).toHaveLength(1)
    expect(cfg.testRunners[0]!.id).toBe("node")
    expect(cfg.testRunners[0]!.scopeArgs(["a.test.js"])).toEqual(["--test", "a.test.js"])
    expect(cfg.testRunners[0]!.buildCommand).toBe(true)
    expect(cfg.testRunners[0]!.reportFormat).toBe("junit")
    expect(cfg.testRunners[0]!.reportArgs).toEqual(["--junit={file}"])
  })

  it("rejects invalid reportFormat", async () => {
    await writeFile(path.join(dir, "kilo.json"), JSON.stringify({ tdd: { testRunners: [{ id: "x", match: ["x"], reportFormat: "xml" }] } }))
    await expect(loadConfig(dir)).rejects.toThrow(/reportFormat/)
  })

  it("mergeConfig rejects invalid arrays", () => {
    expect(() => mergeConfig(DEFAULT_CONFIG, { testPatterns: [1] } as any)).toThrow()
  })
})
