// testagent_change - new file
import { spawn } from "../util/process"
import type { ChildProcess } from "child_process"
import * as readline from "readline"
import { TestflowMessageBridge } from "./testflow-bridge"

export interface SdtRunnerOpts {
  cmd: string
  args: string[]
  cwd: string
  env: Record<string, string | undefined>
  sessionID: string
  userText: string
  /** Reuse the webview's optimistic message ID to avoid creating a duplicate user message turn. */
  userMessageID?: string
  post: (msg: unknown) => void
}

type JsonLine = Record<string, unknown>

export class SdtRunner {
  private proc: ChildProcess | null = null
  private bridge = new TestflowMessageBridge()
  private running = false

  run(opts: SdtRunnerOpts): void {
    if (this.running) {
      // Notify via bridge so the error appears inline in the chat
      opts.post({ type: "testflow.error", sessionID: opts.sessionID, error: "Another testflow process is already running" })
      return
    }

    this.running = true
    this.bridge.start({ sessionID: opts.sessionID, userText: opts.userText, userMessageID: opts.userMessageID, post: opts.post })

    this.proc = spawn("testflow", [opts.cmd, ...opts.args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, KILO_INTEGRATION: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    })

    const rl = readline.createInterface({ input: this.proc.stdout!, terminal: false })
    rl.on("line", (line) => {
      if (!line.trim()) return
      try {
        const event = JSON.parse(line) as JsonLine
        this.dispatch(event)
      } catch {
        this.bridge.onText(line)
      }
    })

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) this.bridge.onLog("error", text)
    })

    this.proc.on("close", (code) => {
      this.bridge.onDone(code ?? 0)
      this.cleanup()
    })

    this.proc.on("error", (err) => {
      this.bridge.onError(err.message)
      this.bridge.onDone(1)
      this.cleanup()
    })
  }

  reply(id: string, answers: string[]): void {
    if (!this.proc?.stdin?.writable) return
    this.proc.stdin.write(JSON.stringify({ type: "question_reply", id, answers }) + "\n")
    this.bridge.onQuestionAnswered(id)
  }

  reject(id: string): void {
    if (!this.proc?.stdin?.writable) return
    this.proc.stdin.write(JSON.stringify({ type: "question_reject", id }) + "\n")
    this.bridge.onQuestionAnswered(id)
  }

  abort(): void {
    if (!this.proc) return
    try {
      this.proc.kill("SIGTERM")
    } catch {
      // process may have already exited
    }
    this.bridge.onDone(1, "Aborted by user")
    this.cleanup()
  }

  isRunning(): boolean {
    return this.running
  }

  private dispatch(event: JsonLine): void {
    const type = event.type as string
    switch (type) {
      case "step":
        this.bridge.onStep(
          event.title as string,
          event.status as "start" | "complete" | "exception",
          event.stage_id as string | undefined,
        )
        break
      case "question":
        this.bridge.onQuestion(
          event.id as string,
          event.header as string,
          event.question as string,
          event.options as { label: string; description: string }[],
          event.multiple as boolean | undefined,
        )
        break
      case "agent_start":
        this.bridge.onAgentStart(event.skill as string | undefined, event.prompt as string | undefined)
        break
      case "agent_done":
        this.bridge.onAgentDone()
        break
      case "text":
        this.bridge.onText(event.text as string)
        break
      case "log":
        this.bridge.onLog(event.level as string, event.message as string)
        break
      case "error":
        this.bridge.onError(event.error as string)
        break
      case "done":
        // handled by proc.on("close")
        break
      default:
        this.bridge.onText(JSON.stringify(event))
    }
  }

  private cleanup(): void {
    this.running = false
    this.proc = null
  }
}
