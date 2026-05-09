/**
 * Compile-time backend runtime selection.
 *
 * BACKEND_RUNTIME is injected by esbuild `define` at build time.
 * - "testagent" → spawns bin/testagent (Bun binary)
 * - "opencode"  → spawns node cli.mjs (Node.js + nodejs-server)
 *
 * All conditional branches are dead-code-eliminated at compile time,
 * so each VSIX only contains the relevant code path.
 */

declare const BACKEND_RUNTIME: "testagent" | "opencode"

export type Runtime = "testagent" | "opencode"

/** Resolved at compile time — never changes at runtime. */
export const runtime: Runtime = typeof BACKEND_RUNTIME !== "undefined" ? BACKEND_RUNTIME : "testagent"

export function isTestagent(): boolean {
  return runtime === "testagent"
}

export function isOpencode(): boolean {
  return runtime === "opencode"
}
