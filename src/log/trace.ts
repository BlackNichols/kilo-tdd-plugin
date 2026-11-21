import { appendFile, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === "bigint") return v.toString()
    if (v instanceof RegExp) return String(v)
    if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack }
    if (typeof v === "object" && v !== null) {
      if (seen.has(v as object)) return "[Circular]"
      seen.add(v as object)
    }
    return v
  })
}

export function traceDir(cwd: string): string {
  return path.join(cwd, ".kilo", "tdd", "logs")
}

export async function trace(cwd: string, event: string, data: Record<string, unknown> = {}): Promise<void> {
  try {
    const dir = traceDir(cwd)
    await mkdir(dir, { recursive: true })
    const entry = {
      ts: new Date().toISOString(),
      pid: process.pid,
      event,
      ...data,
    }
    await appendFile(path.join(dir, "trace.jsonl"), safeStringify(entry) + "\n", "utf8")
  } catch {
    // best-effort
  }
}

export async function traceDetail(cwd: string, name: string, data: Record<string, unknown>): Promise<string | null> {
  try {
    const dir = traceDir(cwd)
    await mkdir(dir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, "-")
    const rand = Math.random().toString(16).slice(2, 8)
    const file = path.join(dir, `${name}-${ts}-${rand}.json`)
    await writeFile(file, safeStringify(data), "utf8")
    return path.relative(cwd, file)
  } catch {
    return null
  }
}
