// testagent_change - new file
import { createContext, useContext, createSignal, onCleanup, type ParentComponent, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { useVSCode } from "../context/vscode"
import type { ExtensionMessage } from "../types/messages"

export interface TestflowStep {
  title: string
  status: "start" | "complete" | "exception"
  stage_id?: string
}

export interface TestflowQuestion {
  id: string
  header: string
  question: string
  options: { label: string; description: string }[]
  multiple?: boolean
  custom?: boolean
}

export interface TestflowState {
  steps: TestflowStep[]
  question: TestflowQuestion | null
  agentRunning: boolean
  agentSkill?: string
  agentPrompt?: string
  logs: { level: string; message: string }[]
  running: boolean
  error: string | null
  done: boolean
  exitCode: number
  summary?: string
}

interface TestflowContextValue {
  state: Accessor<TestflowState>
  reply: (id: string, answers: string[]) => void
  reject: (id: string) => void
  abort: () => void
}

const TestflowContext = createContext<TestflowContextValue>()

export function useTestflow(): TestflowContextValue {
  const ctx = useContext(TestflowContext)
  if (!ctx) throw new Error("useTestflow must be used within TestflowProvider")
  return ctx
}

export const TestflowProvider: ParentComponent = (props) => {
  const vscode = useVSCode()

  const [state, setState] = createStore<TestflowState>({
    steps: [],
    question: null,
    agentRunning: false,
    logs: [],
    running: false,
    error: null,
    done: false,
    exitCode: 0,
  })

  const handle = (msg: ExtensionMessage) => {
    const m = msg as any
    switch (m.type) {
      case "testflow.text":
        setState("logs", (prev) => [...prev, { level: "info", message: m.text }])
        break
      case "testflow.step":
        setState("steps", (prev) => [...prev, { title: m.title, status: m.status, stage_id: m.stage_id }])
        setState("running", true)
        break
      case "testflow.question":
        setState("question", {
          id: m.id,
          header: m.header,
          question: m.question,
          options: m.options,
          multiple: m.multiple,
          custom: m.custom,
        })
        break
      case "testflow.agent_start":
        setState("agentRunning", true)
        setState("agentSkill", m.skill)
        setState("agentPrompt", m.prompt)
        break
      case "testflow.agent_done":
        setState("agentRunning", false)
        setState("agentSkill", undefined)
        setState("agentPrompt", undefined)
        break
      case "testflow.log":
        setState("logs", (prev) => [...prev, { level: m.level, message: m.message }])
        break
      case "testflow.error":
        setState("error", m.error)
        break
      case "testflow.done":
        setState("running", false)
        setState("done", true)
        setState("exitCode", m.exitCode)
        setState("summary", m.summary)
        setState("question", null)
        setState("agentRunning", false)
        break
    }
  }

  const unsubscribe = vscode.onMessage(handle)
  onCleanup(unsubscribe)

  const reply = (id: string, answers: string[]) => {
    setState("question", null)
    vscode.postMessage({ type: "testflow.questionReply", id, answers })
  }

  const reject = (id: string) => {
    setState("question", null)
    vscode.postMessage({ type: "testflow.questionReject", id })
  }

  const abort = () => {
    vscode.postMessage({ type: "testflow.abort" })
  }

  const contextValue: TestflowContextValue = {
    state: () => state,
    reply,
    reject,
    abort,
  }

  return (
    <TestflowContext.Provider value={contextValue}>
      {props.children}
    </TestflowContext.Provider>
  )
}
