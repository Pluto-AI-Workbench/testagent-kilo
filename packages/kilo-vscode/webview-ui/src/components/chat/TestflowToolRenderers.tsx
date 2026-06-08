// testagent_change - new file
/**
 * TestflowToolRenderers
 *
 * Registers the /task-query tool renderer into ToolRegistry so the standard
 * AssistantMessage / Part pipeline can render its result card natively.
 *
 * Testflow-related tools (testflow-progress, etc.) are rendered inline by
 * AssistantMessage.TestflowToolCard instead, so they're not registered here.
 *
 * Call registerTestflowToolRenderers() once at app startup (after kilo-ui
 * tool registrations have run).
 */

import { Component, Show } from "solid-js"
import { ToolRegistry, type ToolProps } from "@kilocode/kilo-ui/message-part"
import { BasicTool } from "@kilocode/kilo-ui/basic-tool"
import { Markdown } from "@kilocode/kilo-ui/markdown"

// ---------------------------------------------------------------------------
// task-query
// ---------------------------------------------------------------------------

const TaskQueryTool: Component<ToolProps> = (props) => {
  const title = () => ((props.input as any).title as string) || "任务详情"
  const output = () => props.output ?? ""
  const formatted = () => {
    const raw = output()
    if (!raw) return ""
    try {
      return "```json\n" + JSON.stringify(JSON.parse(raw), null, 2) + "\n```"
    } catch {
      return raw
    }
  }

  return (
    <BasicTool
      icon="mcp"
      status={props.status}
      trigger={{
        title: title(),
        titleClass: "task-query-title",
        subtitle: "该命令操作不涉及上下文对话",
        subtitleClass: "task-query-subtitle",
      }}
      defaultOpen={true}
    >
      <Show when={formatted()}>
        {(text) => (
          <div data-component="tool-output" data-scrollable>
            <Markdown text={text()} />
          </div>
        )}
      </Show>
    </BasicTool>
  )
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

let registered = false

export function registerTestflowToolRenderers() {
  if (registered) return
  registered = true

  ToolRegistry.register({ name: "task-query", render: TaskQueryTool })
}
