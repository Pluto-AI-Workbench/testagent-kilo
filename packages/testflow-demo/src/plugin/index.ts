// Self-contained testflow plugin - no external imports

function join(...parts: string[]): string {
  return parts.filter(Boolean).join("/").replace(/\\/g, "/").replace(/\/+/g, "/")
}

interface Artifact {
  id: string
  generates: string
  description: string
  instruction: string
  checks: unknown[]
}

interface TestflowConfig {
  version: string
  artifacts: Artifact[]
}

function loadConfig(dir: string): TestflowConfig | null {
  const candidates = [join(dir, "testflow.json"), join(dir, ".testflow", "testflow.json")]
  for (const p of candidates) {
    try {
      // Bun.file() should be available when loaded by testagent runtime
      const file = (globalThis as any).Bun?.file?.(p)
      if (file) {
        const text = file.textSync?.() ?? file.text()
        var content = typeof text === "string" ? text : text
        return JSON.parse(content)
      }
    } catch {}
    // Fallback: try loading as a URL using fetch (for Node.js runtime)
    try {
      const fs = (globalThis as any).process?.versions?.node ? require("fs") : null
      if (fs?.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, "utf-8"))
      }
    } catch {}
  }
  return null
}

function validate(artifact: Artifact, output: string) {
  return {
    passed: false,
    message: `Artifact "${artifact.id}" validation failed (demo): expected "PASS", got "${output.substring(0, 50)}..."`,
  }
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

const plugin = async (ctx: any) => {
  return {
    "command.execute.before": async (input: any, output: any) => {
      console.log("[testflow] Intercepted command:", input.command)
      console.log("[testflow] Arguments:", input.arguments)

      if (input.command === "testflow" && input.arguments.trim().startsWith("new")) {
        console.log("\n[testflow] ========================================")
        console.log("[testflow] Handling /testflow new command...")
        console.log("[testflow] ========================================")

        const cfg = loadConfig(ctx.directory)
        if (!cfg) {
          console.log("[testflow] ERROR: testflow.json not found in", ctx.directory)
          output.parts = [{ type: "text", id: "tf-err", text: "[testflow] ERROR: testflow.json not found" }]
          return
        }

        console.log("[testflow] Loaded config with", cfg.artifacts.length, "artifacts")

        const results: string[] = []
        for (const art of cfg.artifacts) {
          console.log(`\n[testflow] --- Processing artifact: ${art.id} ---`)
          console.log(`[testflow] Instruction: "${art.instruction.trim()}"`)

          try {
            const sessionRes = await ctx.client.session.create({})
            if (!sessionRes.data) throw new Error("Failed to create session")

            const sid = sessionRes.data.id
            console.log(`[testflow] Created session: ${sid}`)

            await ctx.client.session.promptAsync({
              sessionID: sid,
              messageID: `testflow-${art.id}-${Date.now()}`,
              parts: [{ type: "text", text: art.instruction }],
            })

            console.log("[testflow] Sent instruction, polling for response...")
            let responseText = ""
            for (let i = 0; i < 30; i++) {
              await wait(1000)
              try {
                const msgRes = await ctx.client.session.messages({ sessionID: sid, limit: 10 })
                if (msgRes.data) {
                  const msgs = Array.isArray(msgRes.data) ? msgRes.data : []
                  const assistant = msgs.find(
                    (m: any) => m.role === "assistant" && m.parts?.some((p: any) => p.type === "text"),
                  )
                  if (assistant) {
                    responseText = (assistant.parts || [])
                      .filter((p: any) => p.type === "text")
                      .map((p: any) => p.text)
                      .join("")
                    console.log(`[testflow] Got response (${responseText.length} chars)`)
                    break
                  }
                }
              } catch {}
            }

            if (!responseText) {
              console.log("[testflow] No response received after 30s")
              responseText = "[No response]"
            }

            const v = validate(art, responseText)
            if (!v.passed) {
              console.log(`[testflow] VALIDATION FAILED: ${v.message}`)
              results.push(`FAILED: ${art.id} - ${v.message}`)
            } else {
              results.push(`PASSED: ${art.id}`)
            }
          } catch (e) {
            console.log(`[testflow] Error:`, e)
            results.push(`ERROR: ${art.id} - ${e}`)
          }
        }

        output.parts = [
          {
            type: "text",
            id: "tf-result",
            text:
              "[testflow] Flow execution completed\n\nResults:\n" +
              results.map((r) => `  - ${r}`).join("\n") +
              "\n\nNote: Validation is in demo mode (always fails)",
          },
        ]

        console.log("\n[testflow] Flow execution completed")
        console.log("[testflow] ========================================")
      }
    },

    event: async (input: any) => {
      const t = input.event?.type as string
      if (t && t !== "server.heartbeat") {
        console.log("[testflow] Event:", t)
      }
    },

    "tool.execute.before": async (input: any) => {
      console.log("[testflow] Tool before:", input.tool)
    },

    "tool.execute.after": async (input: any, output: any) => {
      console.log("[testflow] Tool after:", input.tool, output?.title)
    },
  }
}

export { plugin }