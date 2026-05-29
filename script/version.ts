#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { $ } from "bun"

const output = [`version=${Script.version}`]

if (!Script.preview) {
  // kilocode_change start - create release; changelog generation and
  // release notes are handled by publish.ts on the same runner that commits.

  // testagent_change start - check if release already exists
  const existingRelease =
    await $`gh release view v${Script.version} --json tagName,databaseId,isDraft --repo ${process.env.GH_REPO}`
      .nothrow()
      .json()
      .catch(() => null)

  if (!existingRelease) {
    console.log(`Creating new release v${Script.version}`)
    await $`gh release create v${Script.version} --title "v${Script.version}" --notes "" --repo ${process.env.GH_REPO}`
  } else {
    console.log(`Release v${Script.version} already exists, reusing it`)
    if (existingRelease.isDraft) {
      console.log(`Publishing existing draft release v${Script.version}`)
      await $`gh release edit v${Script.version} --draft=false --repo ${process.env.GH_REPO}`
    }
  }
  // testagent_change end

  const release =
    await $`gh release view v${Script.version} --json tagName,databaseId --repo ${process.env.GH_REPO}`.json()
  output.push(`release=${release.databaseId}`)
  output.push(`tag=${release.tagName}`)
  // kilocode_change end
  // kilocode_change start - handle both beta and rc preview channels
} else if (Script.channel === "beta" || Script.channel === "rc") {
  // testagent_change start - check if release already exists
  const existingRelease =
    await $`gh release view v${Script.version} --json tagName,databaseId --repo ${process.env.GH_REPO}`
      .nothrow()
      .json()
      .catch(() => null)

  if (!existingRelease) {
    console.log(`Creating new prerelease v${Script.version}`)
    await $`gh release create v${Script.version} -d --prerelease --title "v${Script.version}" --repo ${process.env.GH_REPO}`
  } else {
    console.log(`Prerelease v${Script.version} already exists, reusing it`)
  }
  // testagent_change end

  const release =
    await $`gh release view v${Script.version} --json tagName,databaseId --repo ${process.env.GH_REPO}`.json()
  output.push(`release=${release.databaseId}`)
  output.push(`tag=${release.tagName}`)
  // kilocode_change end
}

output.push(`repo=${process.env.GH_REPO}`)

if (process.env.GITHUB_OUTPUT) {
  await Bun.write(process.env.GITHUB_OUTPUT, output.join("\n"))
}

process.exit(0)
