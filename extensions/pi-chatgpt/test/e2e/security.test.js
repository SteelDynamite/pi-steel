import assert from "node:assert/strict"
import test from "node:test"
import { SelectList } from "@earendil-works/pi-tui"
import extension, { __test__ } from "../../extensions/chatgpt.js"

test("untrusted display text cannot emit terminal controls or alter provider payloads", async (t) => {
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
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }),
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
  let metadata
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (_url, options) => {
      assert.equal(options.headers.Authorization, `Bearer ${token}`)
      return new Response(
        JSON.stringify({
          ...metadata,
          rate_limit: {
            primary_window: { used_percent: 42, limit_window_seconds: 604800 },
          },
        }),
      )
    },
  )
  for (const source of ["remote", "jwt"]) {
    metadata =
      source === "remote"
        ? {
            email: `remote${controls}@example.com`,
            plan_type: `remote-plan${controls}`,
          }
        : {}
    const previousMenus = menus.length
    await commands.get("chatgpt").handler("", ctx)
    assert.equal(menus.length, previousMenus + 2)
    const details = menus.at(-1)
    assert.ok(details.includes("provider: openai"))
    assert.ok(details.some((line) => line.startsWith(`plan: ${source}-plan`)))
    assert.ok(
      details.some(
        (line) =>
          line.startsWith(`email: ${source}`) && line.endsWith("@example.com"),
      ),
    )
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
  assert.equal(fetchMock.mock.callCount(), 2)
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
