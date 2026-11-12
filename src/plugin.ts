import type { Plugin } from "@kilocode/plugin"
import { CycleStore } from "./store/store"
import { createTools } from "./tools/tdd"
import { enforceBeforeTool } from "./enforce/hooks"
import { loadConfig } from "./types/load-config"

const plugin: Plugin = async (input) => {
  const config = await loadConfig(input.directory)
  const store = new CycleStore(input.directory)
  const tools = createTools(store, input.directory, config)

  return {
    tool: {
      ...tools,
    },
    "tool.execute.before": async (hookInput, output) => {
      await enforceBeforeTool({ config, store, directory: input.directory }, hookInput, output)
    },
  }
}

export default { id: "kilo-tdd-plugin", server: plugin }