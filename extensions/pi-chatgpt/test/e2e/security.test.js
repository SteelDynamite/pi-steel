import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { SelectList } from "@earendil-works/pi-tui"
import extension, { __test__ } from "../../extensions/chatgpt.js"

test("untrusted text cannot escape the footer, trigger quota dispatch, or alter provider payloads", async (t) => {
  const controls = "\x1b]52;c;UE9D\x07\x1b[31m\x1bPdata\x1b\\\x9b31m\r\n\t"
  const token = `e30.${Buffer.from(
    JSON.stringify({
      "https://api.openai.com/profile": { email: `jwt${controls}@example.com` },
      "https://api.openai.com/auth": {
        chatgpt_plan_type: `jwt-plan${controls}`,
      },
    }),
  ).toString("base64url")}.`
  const events = new Map()
  const commands = new Map()
  const menus = []
  const notifications = []
  let authCalls = 0
  extension({
    on: (name, handler) => events.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
  })
  t.after(() => events.get("session_shutdown")())
  const ctx = {
    mode: "rpc",
    model: { provider: "openai", id: "gpt-5.5", contextWindow: 1000 },
    modelRegistry: {
      isUsingOAuth: () => true,
      getApiKeyAndHeaders: async () => {
        authCalls++
        return { ok: true, apiKey: token }
      },
    },
    sessionManager: {
      getEntries: () => [],
      getCwd: () => `/project${controls}`,
      getSessionName: () => `session${controls} 日本語 🚀`,
    },
    getContextUsage: () => undefined,
    ui: {
      select: async (_title, options) => {
        menus.push(options)
        return options[0]
      },
      notify: (message) => notifications.push(message),
    },
  }
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    assert.fail("quota must not dispatch for unverified credentials")
  })
  // Parsing retains raw metadata; fail-closed commands must never display it.
  assert.equal(
    __test__.getTokenMetadata(token).email,
    `jwt${controls}@example.com`,
  )
  const snapshot = __test__.parseUsageSnapshot({
    email: `remote${controls}@example.com`,
    plan_type: `remote-plan${controls}`,
  })
  assert.equal(snapshot.email, `remote${controls}@example.com`)
  assert.equal(snapshot.planType, `remote-plan${controls}`)
  for (const command of ["chatgpt", "chatgpt-limit"]) {
    const previousMenus = menus.length
    await commands.get(command).handler("", ctx)
    assert.equal(menus.length, previousMenus + 1)
    assert.match(
      notifications.at(-1),
      /quota requests disabled.*Settings → Usage/,
    )
    assert.doesNotMatch(notifications.at(-1), /jwt|remote-plan|@example\.com/)
    const details = menus.at(-1)
    const identity = (value) => value
    const selector = new SelectList(
      details.map((label) => ({ value: label, label })),
      details.length,
      {
        selectedPrefix: identity,
        selectedText: identity,
        description: identity,
        scrollInfo: identity,
        noMatch: identity,
      },
    )
    for (const line of [...details, ...selector.render(300)]) {
      assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f]/)
    }
  }
  assert.equal(authCalls, 0)
  assert.equal(fetchMock.mock.callCount(), 0)
  notifications.length = 0
  ctx.model.id = `gpt-5.5${controls}`
  for (const provider of ["openai", `other${controls}`]) {
    ctx.model.provider = provider
    const lines = __test__.renderFooter(
      {},
      ctx,
      {
        getGitBranch: () => `branch${controls}`,
        getAvailableProviderCount: () => 2,
      },
      { fg: (_color, text) => text },
      300,
    )
    assert.equal(lines.length, 2)
    assert.match(lines[0], /日本語 🚀/)
    assert.match(lines[1], /gpt-5\.5/)
    for (const line of lines) {
      assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f]/)
    }
  }
  ctx.model.provider = "openai"
  await commands.get("fast").handler("temporary ultrafast", ctx)
  await commands.get("fast").handler("status", ctx)
  assert.equal(notifications.length, 2)
  for (const message of notifications) {
    assert.doesNotMatch(message, /[\x00-\x1f\x7f-\x9f]/)
  }
  assert.equal(ctx.model.id, `gpt-5.5${controls}`)
  ctx.model = { provider: "openai", id: "gpt-6-astra" }
  const payload = { model: "gpt-6-astra", input: controls }
  assert.deepEqual(events.get("before_provider_request")({ payload }, ctx), {
    ...payload,
    service_tier: "ultrafast",
  })
  assert.equal(payload.input, controls)
})

test("footer hides cached quota and HTTP errors while preserving speed and statuses", async () => {
  // Seed private state only in an isolated test module, without resolving credentials.
  const source = await readFile(
    new URL("../../extensions/chatgpt.js", import.meta.url),
    "utf8",
  )
  const ctx = {
    model: { provider: "openai", id: "gpt-6-astra", contextWindow: 1000 },
    modelRegistry: { isUsingOAuth: () => true },
    sessionManager: {
      getEntries: () => [],
      getCwd: () => "/project",
      getSessionName: () => undefined,
    },
    getContextUsage: () => ({ contextWindow: 1000, percent: 10 }),
  }
  const footerData = {
    getGitBranch: () => undefined,
    getAvailableProviderCount: () => 1,
    getExtensionStatuses: () => new Map([["tokenSpeed", "42 tok/s"]]),
  }
  for (const snapshot of [
    { weekly: { usedPercent: 42, resetAt: 1234567890 } },
    { httpStatus: 401 },
  ]) {
    const seeded = source
      .replace(
        "let usageSnapshot",
        `let usageSnapshot = ${JSON.stringify(snapshot)}`,
      )
      .replace(
        '"@earendil-works/pi-tui"',
        JSON.stringify(import.meta.resolve("@earendil-works/pi-tui")),
      )
    const isolated = await import(
      `data:text/javascript;base64,${Buffer.from(seeded).toString("base64")}`
    )
    const rendered = isolated.__test__
      .renderFooter(
        {},
        ctx,
        footerData,
        { fg: (_color, text) => text },
        160,
        "ultrafast",
      )
      .join("\n")
    assert.match(rendered, /Ultrafast/)
    assert.match(rendered, /42 tok\/s/)
    assert.match(rendered, /10\.0%\/1\.0k/)
    assert.doesNotMatch(rendered, /W 42%|5h|WP |Usage:|401|quota|unavailable/i)
  }
})

test("quota windows reject nonfinite numbers and reset arithmetic overflow", () => {
  const valid = { used_percent: 0, limit_window_seconds: 604800 }
  const parse = (window) =>
    __test__.parseUsageSnapshot({
      rate_limit: { primary_window: window },
    })
  for (const field of ["used_percent", "limit_window_seconds", "reset_at"]) {
    for (const value of [NaN, Infinity, -Infinity]) {
      const snapshot = parse({ ...valid, [field]: value })
      assert.equal(snapshot.weekly, undefined)
      assert.equal(snapshot.fiveHour, undefined)
    }
  }
  assert.equal(parse({ ...valid, reset_at: 1e308 }).weekly, undefined)
  assert.equal(
    parse(JSON.parse('{"used_percent":1e400,"limit_window_seconds":604800}'))
      .weekly,
    undefined,
  )
  assert.deepEqual(parse(valid).weekly, {
    usedPercent: 0,
    windowSeconds: 604800,
    resetAt: undefined,
  })
  for (const seconds of [604680, 604800, 604920]) {
    const window = parse({
      ...valid,
      limit_window_seconds: seconds,
      reset_at: 0,
    })
    assert.equal(window.weekly.resetAt, 0)
    assert.equal(window.weekly.usedPercent, 0)
  }
  assert.equal(parse({ ...valid, used_percent: "42" }).weekly, undefined)
  assert.equal(parse(null).weekly, undefined)
  assert.equal(
    parse({ ...valid, reset_at: "unknown" }).weekly.resetAt,
    undefined,
  )
})
