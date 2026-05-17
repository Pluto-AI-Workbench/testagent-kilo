// testagent_change - new file
import { spawn } from "../util/process"
import type { ChildProcess } from "child_process"
import * as readline from "readline"

export interface SdtRunnerOpts {
  cmd: string
  args: string[]
  cwd: string
  env: Record<string, string | undefined>
  sessionID: string
  post: (msg: unknown) => void
}

type JsonLine = Record<string, unknown>

export class SdtTestRunner {
  private proc: ChildProcess | null = null

  run(opts: SdtRunnerOpts): void {
    const sid = opts.sessionID

    this.proc = spawn(opts.cmd, opts.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    })

    let stdout = ""
    let stderr = ""

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
      opts.post({ type: "testflow.text", sessionID: sid, text: chunk.toString() })
    })

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
      opts.post({ type: "testflow.log", sessionID: sid, level: "error", message: chunk.toString() })
    })

    this.proc.on("close", (code) => {
      opts.post({ type: "testflow.done", sessionID: sid, exitCode: code ?? 0, stdout, stderr })
      this.proc = null
    })

    this.proc.on("error", (err) => {
      opts.post({ type: "testflow.error", sessionID: sid, error: err.message })
      this.proc = null
    })
  }

  abort(): void {
    if (!this.proc) return
    try {
      this.proc.kill("SIGTERM")
    } catch {}
    this.proc = null
  }
}

export class SdtRunner {
  private proc: ChildProcess | null = null
  private sessionID = ""
  private post: ((msg: unknown) => void) | null = null
  private running = false

  run(opts: SdtRunnerOpts): void {
    if (this.running) {
      opts.post({ type: "testflow.error", sessionID: opts.sessionID, error: "Another testflow process is already running" })
      return
    }

    this.sessionID = opts.sessionID
    this.post = opts.post
    this.running = true

    this.proc = spawn("testflow", opts.args, {
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
        this.forward("text", { text: line })
      }
    })

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) this.forward("log", { level: "error", message: text })
    })

    this.proc.on("close", (code) => {
      this.forward("done", { exitCode: code ?? 0 })
      this.cleanup()
    })

    this.proc.on("error", (err) => {
      this.forward("error", { error: err.message })
      this.cleanup()
    })
  }

  reply(id: string, answers: string[]): void {
    if (!this.proc?.stdin?.writable) return
    this.proc.stdin.write(JSON.stringify({ type: "question_reply", id, answers }) + "\n")
  }

  reject(id: string): void {
    if (!this.proc?.stdin?.writable) return
    this.proc.stdin.write(JSON.stringify({ type: "question_reject", id }) + "\n")
  }

  abort(): void {
    if (!this.proc) return
    try {
      this.proc.kill("SIGTERM")
    } catch {
      // process may have already exited
    }
    this.forward("done", { exitCode: 1, summary: "Aborted by user" })
    this.cleanup()
  }

  isRunning(): boolean {
    return this.running
  }

  private dispatch(event: JsonLine): void {
    const type = event.type as string
    switch (type) {
      case "step":
      case "question":
      case "agent_start":
      case "agent_done":
      case "text":
      case "log":
      case "error":
      case "done":
        this.forward(type, event)
        break
      default:
        this.forward("text", { text: JSON.stringify(event) })
    }
  }

  private forward(type: string, payload: Record<string, unknown>): void {
    this.post?.({
      type: `testflow.${type}`,
      sessionID: this.sessionID,
      ...payload,
    })
  }

  private cleanup(): void {
    this.running = false
    this.proc = null
  }
}
