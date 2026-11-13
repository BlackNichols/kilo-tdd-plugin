import type { Plugin } from "@kilocode/plugin"
import { CycleStore } from "./store/store"
import { createTools } from "./tools/tdd"
import { enforceBeforeTool } from "./enforce/hooks"
import { loadConfigWithSource } from "./types/load-config"

const plugin: Plugin = async (input) => {
  const { config, source } = await loadConfigWithSource(input.directory)
  const store = new CycleStore(input.directory)
  const tools = createTools(store, input.directory, config, source)

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