import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent"
import extension from "../../extensions/chatgpt.js"

// Real host resolution, synthetic credentials; no providers or active settings.
test("real host stale OAuth snapshot cannot dispatch a replacement API key", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "chatgpt-provenance-"))
  t.after(() => rm(home, { recursive: true, force: true }))
  let credential = {
    type: "oauth",
    access: "synthetic-oauth",
    refresh: "synthetic-refresh",
    expires: Date.now() + 3600000,
  }
  const credentials = {
    read: async (id) => (id === "openai" ? credential : undefined),
    list: async () => [{ providerId: "openai", type: credential.type }],
    modify: async (_id, fn) => (credential = await fn(credential)),
    delete: async () => {
      credential = undefined
    },
  }
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    modelsStorePath: join(home, "models.json"),
    allowModelNetwork: false,
  })
  const registry = new ModelRegistry(runtime)
  const model = registry.find("openai", "gpt-5.5")
  assert.ok(model)
  assert.equal(registry.isUsingOAuth(model), true)
  credential = { type: "api_key", key: "synthetic-replacement-key" }
  // Establish the actual host bug boundary: independent cached status remains
  // OAuth while the facade's fresh result is an API key without a type tag.
  assert.equal(registry.isUsingOAuth(model), true)
  const resolved = await registry.getApiKeyAndHeaders(model)
  assert.equal(resolved.apiKey, credential.key)
  assert.equal(resolved.type, undefined)
  let resolutions = 0
  t.mock.method(registry, "getApiKeyAndHeaders", async () => {
    resolutions++
    return resolved
  })
  const fetch = t.mock.method(globalThis, "fetch", () => {
    assert.fail("Quota must fail closed before dispatch")
  })
  const commands = new Map()
  const handlers = new Map()
  const notices = []
  extension({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
  })
  const ctx = {
    model,
    modelRegistry: registry,
    ui: {
      select: async (_title, choices) => choices[0],
      notify: (text) => notices.push(text),
    },
  }
  await commands.get("chatgpt").handler("", ctx)
  assert.match(notices[0], /cannot prove.*OAuth.*Settings → Usage/)
  assert.equal(resolutions, 0)
  assert.equal(fetch.mock.callCount(), 0)
  await handlers.get("session_shutdown")()
})

test("shutdown retires a pending quota menu before it accesses invalid host context", async (t) => {
  let select
  const selection = new Promise((resolve) => {
    select = resolve
  })
  const commands = new Map()
  const handlers = new Map()
  extension({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
  })
  const ctx = {
    ui: { select: () => selection },
    get model() {
      assert.fail("Retired context accessed")
    },
    get modelRegistry() {
      assert.fail("Retired context accessed")
    },
  }
  const fetch = t.mock.method(globalThis, "fetch", () =>
    assert.fail("Retired request"),
  )
  const pending = commands.get("chatgpt").handler("", ctx)
  await handlers.get("session_shutdown")()
  select("Show current usage details")
  await pending
  assert.equal(fetch.mock.callCount(), 0)
})
