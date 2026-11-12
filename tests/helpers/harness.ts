import { CycleStore } from "../../src/store/store"
import { createTools } from "../../src/tools/tdd"
import { enforceBeforeTool } from "../../src/enforce/hooks"
import { DEFAULT_CONFIG } from "../../src/types/config"
import type { TddConfig } from "../../src/types/config"

export function createHarness(dir: string, sessionID = "ses_test", config: TddConfig = DEFAULT_CONFIG) {
  const store = new CycleStore(dir)
  const tools = createTools(store, dir, config)
  const ctx = { sessionID, messageID: "msg_test", agent: "test", directory: dir, worktree: dir, abort: new AbortController().signal, metadata: () => {}, ask: async () => {} } as any

  async function callTool(name: keyof typeof tools, args: any) {
    return (tools[name] as any).execute(args, ctx)
  }

  async function beforeTool(tool: string, args: any) {
    const output = { args }
    await enforceBeforeTool({ config, store, directory: dir }, { tool, sessionID, callID: "call_test" }, output)
    return output.args
  }

  return { store, tools, callTool, beforeTool, sessionID, dir }
}
