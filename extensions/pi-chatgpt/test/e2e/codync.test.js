import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import extension from "../../extensions/chatgpt.js"

async function fixture(
  t,
  { marker, speed = "standard", saved = "standard" } = {},
) {
  const originalEnv = { ...process.env }
  const directory = await mkdtemp(join(tmpdir(), "pi-chatgpt-codync-"))
  process.env.PI_CODING_AGENT_DIR = directory
  process.env.PI_CHATGPT_FAST = "0"
  process.env.PI_CHATGPT_SPEED = speed
  process.env.CODYNC_HOME = "/unused"
  process.env.PI_ACP_PI_COMMAND = "pi"
  delete process.env.CODYNC_PI_MCP_SERVERS
  if (marker !== undefined) process.env.CODYNC_PI_MCP_SERVERS = marker
  const configPath = join(directory, "chatgpt.json")
  const config = `${JSON.stringify({
    quotaWindow: "hidden",
    displayMode: "remaining",
    speedMode: saved,
    fastMode: saved !== "standard",
  })}\n`
  await writeFile(configPath, config)
  t.after(async () => {
    await handlers.get("session_shutdown")()
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
    await rm(directory, { recursive: true, force: true })
  })
  const handlers = new Map()
  const commands = new Map()
  const notices = []
  const api = {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
  }
  extension(api)
  const ctx = {
    mode: "rpc",
    model: { provider: "openai", id: "gpt-6.1-sol" },
    modelRegistry: { isUsingOAuth: () => true },
    sessionManager: { getBranch: () => [] },
    ui: { notify: (message, type) => notices.push({ message, type }) },
  }
  await handlers.get("session_start")({}, ctx)
  return {
    directory,
    configPath,
    config,
    handlers,
    commands,
    notices,
    ctx,
    api,
  }
}

test("Codync enforces Ultrafast over every inherited and saved speed", async (t) => {
  for (const speed of ["standard", "fast", "ultrafast"]) {
    for (const saved of ["standard", "fast", "ultrafast"]) {
      await t.test(`${speed} inherited, ${saved} saved`, async (t) => {
        const { configPath, config, handlers, commands, notices, ctx } =
          await fixture(t, { marker: "{}", speed, saved })
        assert.equal(process.env.PI_CHATGPT_SPEED, "ultrafast")
        assert.equal(process.env.PI_CHATGPT_FAST, "1")
        const payload = { model: ctx.model.id, service_tier: "default" }
        assert.deepEqual(
          handlers.get("before_provider_request")({ payload }, ctx),
          { ...payload, service_tier: "ultrafast" },
        )
        assert.equal(payload.service_tier, "default")
        await commands.get("fast").handler("status", ctx)
        assert.match(
          notices.at(-1).message,
          /Ultrafast \(active\).*Enforced for Codync/,
        )
        for (const command of [
          "temporary",
          "temporary standard",
          "temporary fast",
          "temporary ultrafast",
          "persistent",
          "persistent standard",
          "persistent fast",
          "persistent ultrafast",
          "off",
        ]) {
          await commands.get("fast").handler(command, ctx)
          assert.match(
            notices.at(-1).message,
            /Ultrafast is enforced for Codync/,
          )
          assert.equal(process.env.PI_CHATGPT_SPEED, "ultrafast")
          assert.equal(process.env.PI_CHATGPT_FAST, "1")
          assert.equal(await readFile(configPath, "utf8"), config)
        }
        await handlers.get("session_shutdown")()
        assert.equal(process.env.PI_CHATGPT_SPEED, speed)
        assert.equal(process.env.PI_CHATGPT_FAST, "0")
      })
    }
  }
})

test("Codync preserves model and OAuth guards through model changes and session replacement", async (t) => {
  const { handlers, commands, notices, ctx, api } = await fixture(t, {
    marker: '{"memory":{"command":"unused"}}',
  })
  for (const [provider, id, oauth, supported] of [
    ["openai", "gpt-6-astra", true, true],
    ["openai", "gpt-6.2-astra", true, true],
    ["openai", "gpt-6.2-sol", true, true],
    ["openai", "gpt-5.5", true, false],
    ["openai", "gpt-6.1-sol", false, false],
    ["other", "gpt-6.1-sol", true, false],
    ["openai", "gpt-6.1-sol", true, true],
  ]) {
    ctx.model = { provider, id }
    ctx.modelRegistry.isUsingOAuth = () => oauth
    handlers.get("model_select")({ model: ctx.model }, ctx)
    assert.equal(process.env.PI_CHATGPT_SPEED, "ultrafast")
    assert.equal(process.env.PI_CHATGPT_FAST, supported ? "1" : "0")
    const payload = { model: id }
    assert.deepEqual(
      handlers.get("before_provider_request")({ payload }, ctx),
      supported ? { ...payload, service_tier: "ultrafast" } : undefined,
    )
    await commands.get("fast").handler("status", ctx)
    assert.match(notices.at(-1).message, /Enforced for Codync/)
    assert.equal(notices.at(-1).type, supported ? "info" : "warning")
  }
  for (const reason of ["reload", "new", "resume", "fork"]) {
    await handlers.get("session_shutdown")({ reason })
    assert.equal(process.env.PI_CHATGPT_SPEED, "standard")
    extension(api)
    await handlers.get("session_start")({ reason }, ctx)
    assert.equal(process.env.PI_CHATGPT_SPEED, "ultrafast")
  }
})

test("ordinary RPC clients and unrelated Codync variables do not force speed", async (t) => {
  for (const marker of [undefined, "", " \t\n"]) {
    await t.test(`marker ${JSON.stringify(marker)}`, async (t) => {
      const { commands, notices, ctx } = await fixture(t, { marker })
      assert.equal(process.env.PI_CHATGPT_SPEED, "standard")
      await commands.get("fast").handler("temporary fast", ctx)
      assert.equal(process.env.PI_CHATGPT_SPEED, "fast")
      assert.doesNotMatch(notices.at(-1).message, /Codync/)
    })
  }
})

test("real Pi RPC context reapplies Codync policy on reload without persisting speed", async (t) => {
  let session
  t.after(async () => {
    if (!session) return
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    })
    session.dispose()
  })
  const { directory, configPath, config, handlers } = await fixture(t, {
    marker: "{}",
  })
  await handlers.get("session_shutdown")()
  const {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
  } = await import("@earendil-works/pi-coding-agent")
  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(directory, "models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  })
  const model = runtime
    .getModels()
    .find((model) => model.provider === "openai" && model.id === "gpt-6.1-sol")
  assert.ok(model)
  const settings = SettingsManager.inMemory({})
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: settings,
    extensionFactories: [extension],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
  })
  await loader.reload()
  ;({ session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    settingsManager: settings,
    resourceLoader: loader,
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(directory),
  }))
  const errors = []
  const notices = []
  await session.bindExtensions({
    mode: "rpc",
    onError: (error) => errors.push(error),
    uiContext: {
      ...session.extensionRunner.getUIContext(),
      notify: (message) => notices.push(message),
    },
  })
  for (let iteration = 0; iteration < 2; iteration++) {
    await session.prompt("/fast off")
    assert.match(notices.at(-1), /Ultrafast is enforced for Codync/)
    await session.prompt("/fast status")
    assert.match(
      notices.at(-1),
      /Ultrafast.*requires ChatGPT OAuth.*Enforced for Codync/,
    )
    assert.equal(process.env.PI_CHATGPT_SPEED, "ultrafast")
    assert.equal(process.env.PI_CHATGPT_FAST, "0")
    assert.equal(await readFile(configPath, "utf8"), config)
    if (iteration === 0) await session.reload()
  }
  assert.deepEqual(errors, [])
  assert.deepEqual(session.messages, [])
})
