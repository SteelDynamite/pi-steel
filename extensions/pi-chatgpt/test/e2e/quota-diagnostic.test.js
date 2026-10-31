import assert from "node:assert/strict"
import test from "node:test"
import diagnostic from "../../extensions/quota-diagnostic.js"

function harness(t) {
  const handlers = new Map()
  const notifications = []
  let command
  diagnostic({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, definition) => {
      assert.equal(name, "chatgpt-quota-diagnostic")
      command = definition.handler
    },
  })
  t.mock.method(globalThis, "fetch", () => {
    assert.fail("Passive diagnostic must not fetch")
  })
  const ctx = {
    model: { provider: "openai", id: "gpt-6-astra" },
    isIdle: () => true,
    modelRegistry: {
      isUsingOAuth: () => true,
      getApiKeyAndHeaders: () => assert.fail("Must not resolve credentials"),
    },
    ui: { notify: (text) => notifications.push(text) },
  }
  return {
    ctx,
    notifications,
    command: (args) => command(args, ctx),
    emit: (name, event = {}) => handlers.get(name)(event, ctx),
    async report() {
      await command("show", ctx)
      return JSON.parse(notifications.at(-1).split("\n").slice(1).join("\n"))
    },
  }
}

const unreadable = {
  get secret() {
    assert.fail("Non-allowlisted value accessed")
  },
  toJSON() {
    assert.fail("Raw metadata serialized")
  },
}

function stream(data) {
  return { provider: "openai", model: "gpt-6-astra", data }
}

test("passive diagnostic is opt-in, quota-only, immutable, and one-request", async (t) => {
  const h = harness(t)
  await h.emit("after_provider_response", { headers: {} })
  assert.deepEqual(await h.report(), {})
  await h.command("arm")
  await h.emit("before_provider_request", unreadable)
  const headers = Object.freeze(
    Object.assign(Object.create(unreadable), {
      "x-codex-primary-used-percent": "12.5",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": "1800000000",
      "x-codex-secondary-used-percent": "0",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-at": "1800100000",
    }),
  )
  await h.emit("after_provider_response", { headers })
  await h.emit("provider_stream_event", stream(unreadable))
  const quota = Object.freeze({
    used_percent: 42,
    window_minutes: 10080,
    reset_at: 1800100000,
  })
  const data = Object.freeze(
    Object.assign(Object.create(unreadable), {
      type: "codex.rate_limits",
      rate_limits: Object.freeze({ primary: null, secondary: quota }),
    }),
  )
  await h.emit("provider_stream_event", stream(data))
  assert.deepEqual(await h.report(), {
    responseHooks: 1,
    streamHooks: 2,
    quotaEvents: 1,
    headers: Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key, Number(value)]),
    ),
    streamQuota: {
      "secondary.used_percent": 42,
      "secondary.window_minutes": 10080,
      "secondary.reset_at": 1800100000,
    },
  })
  const captured = await h.report()
  await h.emit("before_provider_request", unreadable)
  await h.emit("after_provider_response", { headers: unreadable })
  await h.emit("provider_stream_event", stream(data))
  assert.deepEqual(await h.report(), captured)
  await h.command("off")
  assert.deepEqual(await h.report(), {})
})

test("malformed quota values cannot leak remote text; absence is not zero", async (t) => {
  const h = harness(t)
  await h.command("arm")
  await h.emit("before_provider_request")
  await h.emit("after_provider_response", {
    headers: {
      "x-codex-primary-used-percent": "private-token\u001b[31m",
      "x-codex-primary-window-minutes": "",
      "x-codex-primary-reset-at": "Infinity",
      "x-codex-secondary-used-percent": "1e300",
      "x-codex-secondary-window-minutes": "1.5",
      "x-codex-secondary-reset-at": "99999999999999999999999",
      authorization: "private-token",
    },
  })
  await h.emit(
    "provider_stream_event",
    stream({
      type: "codex.rate_limits",
      rate_limits: {
        primary: {
          used_percent: "private-token",
          window_minutes: -1,
          reset_at: Infinity,
        },
        secondary: { used_percent: NaN, window_minutes: 1.5, reset_at: null },
      },
    }),
  )
  const report = await h.report()
  assert.equal(Object.keys(report.headers).length, 6)
  assert.equal(Object.keys(report.streamQuota).length, 6)
  assert.ok(Object.values(report.headers).every((v) => v === "invalid"))
  assert.ok(Object.values(report.streamQuota).every((v) => v === "invalid"))
  assert.doesNotMatch(h.notifications.join("\n"), /private-token|authorization/)
  await h.command("arm")
  await h.emit("before_provider_request")
  await h.emit("after_provider_response", { headers: null })
  for (const data of [null, [], "private-token", { type: "response.done" }]) {
    await h.emit("provider_stream_event", stream(data))
  }
  await h.emit("agent_end")
  assert.deepEqual(await h.report(), {
    responseHooks: 1,
    streamHooks: 4,
    quotaEvents: 0,
    headers: {},
    streamQuota: {},
  })
  assert.match(h.notifications.at(-1), /diagnostic: done/)
})

test("retry responses replace headers, including empty or malformed responses", async (t) => {
  const h = harness(t)
  await h.command("arm")
  await h.emit("before_provider_request")
  await h.emit("after_provider_response", {
    headers: { "x-codex-primary-used-percent": "12" },
  })
  await h.emit("after_provider_response", {
    headers: { "x-codex-secondary-used-percent": "42" },
  })
  assert.deepEqual((await h.report()).headers, {
    "x-codex-secondary-used-percent": 42,
  })
  await h.emit("after_provider_response", { headers: {} })
  assert.deepEqual((await h.report()).headers, {})
  await h.emit("after_provider_response", {
    headers: { "x-codex-primary-used-percent": "13" },
  })
  await h.emit("after_provider_response", { headers: null })
  const report = await h.report()
  assert.deepEqual(report.headers, {})
  assert.equal(report.responseHooks, 5)
  await h.emit("before_provider_request")
  await h.emit("after_provider_response", {
    headers: { "x-codex-primary-used-percent": "99" },
  })
  assert.deepEqual(await h.report(), report)
})

test("OAuth eligibility, routing, idle guard, and lifecycle clearing", async (t) => {
  const h = harness(t)
  h.ctx.modelRegistry.isUsingOAuth = () => false
  await h.command("arm")
  assert.deepEqual(await h.report(), {})
  h.ctx.modelRegistry.isUsingOAuth = () => true
  h.ctx.isIdle = () => false
  await h.command("arm")
  assert.deepEqual(await h.report(), {})
  h.ctx.isIdle = () => true
  for (const provider of ["anthropic", "openai-codex", "openai-codex-2"]) {
    h.ctx.model.provider = provider
    await h.command("arm")
    assert.match(h.notifications.at(-1), /select an openai model/)
    await h.emit("before_provider_request")
    await h.emit("after_provider_response", { headers: unreadable })
    await h.emit("provider_stream_event", {
      provider,
      model: "gpt-6-astra",
      data: unreadable,
    })
    assert.deepEqual(await h.report(), {})
  }
  h.ctx.model.provider = "openai"
  await h.command("arm")
  await h.emit("before_provider_request")
  for (const provider of ["unrelated", "openai-codex", "openai-codex-2"]) {
    await h.emit("provider_stream_event", {
      provider,
      model: "gpt-6-astra",
      data: unreadable,
    })
  }
  await h.emit("provider_stream_event", {
    provider: "openai",
    model: "unrelated",
    data: unreadable,
  })
  h.ctx.modelRegistry.isUsingOAuth = () => false
  await h.emit("after_provider_response", { headers: unreadable })
  assert.equal((await h.report()).responseHooks, 0)
  assert.equal((await h.report()).streamHooks, 0)
  h.ctx.modelRegistry.isUsingOAuth = () => true
  await h.emit("model_select")
  assert.deepEqual(await h.report(), {})
  await h.command("arm")
  await h.emit("session_shutdown")
  assert.deepEqual(await h.report(), {})
})
