import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import http from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { visibleWidth } from "@earendil-works/pi-tui"
import extension, { __test__ } from "../../extensions/chatgpt.js"

const EXTENSION_PATH = resolve("extensions/chatgpt.js")
const HAS_SCRIPT = !spawnSync("script", ["--version"], {
  stdio: "ignore",
}).error
const HAS_EXPECT = !spawnSync("expect", ["-v"], { stdio: "ignore" }).error
const SCRIPT_SKIP = HAS_SCRIPT
  ? false
  : "requires the `script` command for real pi TUI e2e coverage"
const EXPECT_SKIP = HAS_EXPECT
  ? false
  : "requires the `expect` command for interactive real pi TUI e2e coverage"

function encodeBase64Url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

function fakeJwt(payload) {
  return `${encodeBase64Url({ alg: "none" })}.${encodeBase64Url(payload)}.`
}

async function startUsageServer(handler) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    requests.push({ url: req.url, headers: req.headers })
    await handler(req, res)
  })

  server.listen(0, "127.0.0.1")
  await once(server, "listening")

  const { port } = server.address()
  return {
    requests,
    baseUrl: `http://127.0.0.1:${port}/backend-api`,
    close: () =>
      new Promise((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      ),
  }
}

function sendUsageResponse(res, options = {}) {
  const {
    planType,
    fiveHourUsed = 25,
    weeklyUsed = 42,
    fiveHourResetSeconds = 2 * 60 * 60,
    weeklyResetSeconds = 2 * 24 * 60 * 60,
  } = options

  res.writeHead(200, { "content-type": "application/json" })
  res.end(
    JSON.stringify({
      ...(planType ? { plan_type: planType } : {}),
      rate_limit: {
        primary_window: {
          used_percent: fiveHourUsed,
          limit_window_seconds: 5 * 60 * 60,
          reset_at: Math.floor(Date.now() / 1000) + fiveHourResetSeconds,
        },
        secondary_window: {
          used_percent: weeklyUsed,
          limit_window_seconds: 7 * 24 * 60 * 60,
          reset_at: Math.floor(Date.now() / 1000) + weeklyResetSeconds,
        },
      },
    }),
  )
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function scriptCommand(outputFile, command, args) {
  if (process.platform === "darwin")
    return ["script", ["-q", outputFile, command, ...args]]

  // Polling needs each write flushed, not just full blocks or process exit.
  return [
    "script",
    [
      "-q",
      "-f",
      "-c",
      [command, ...args].map(shellQuote).join(" "),
      outputFile,
    ],
  ]
}

async function readIfExists(path) {
  if (!existsSync(path)) return ""
  return readFile(path, "utf8")
}

async function waitForOutput(path, predicate, timeoutMs = 8000) {
  const startedAt = Date.now()
  let output = ""

  while (Date.now() - startedAt < timeoutMs) {
    output = await readIfExists(path)
    if (predicate(output)) return output
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }

  assert.fail(`Timed out after ${timeoutMs}ms waiting for output:\n${output}`)
}

function tclDoubleQuote(value) {
  return `"${String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")}"`
}

function expectSendLiteral(value) {
  return String(value).replaceAll('"', '\\"')
}

function expectBlock(pattern) {
  return `expect {\n  ${tclDoubleQuote(pattern)} {}\n  timeout { exit 1 }\n  eof { exit 1 }\n}`
}

function stripAnsi(value) {
  return String(value)
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
}

function buildPiArgs(model = "gpt-5.5") {
  return [
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-session",
    "--approve",
    "--extension",
    EXTENSION_PATH,
    "--provider",
    "openai",
    "--model",
    model,
  ]
}

async function runRealPiTui({
  baseUrl,
  apiKey,
  model = "gpt-5.5",
  runtimeApiKey,
  extraEnv = {},
  initialConfig,
  trustEnvName = "CHATGPT_TRUST_CUSTOM_BASE_URL",
  waitFor = (text) => text.includes("42%") && text.includes("gpt-5.5"),
  settleMs = 0,
  timeoutMs = 8000,
}) {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-chatgpt-e2e-"))
  const outputFile = join(tempDir, "typescript.log")
  const agentDir = join(tempDir, "agent")
  const sessionDir = join(tempDir, "sessions")

  await mkdir(agentDir, { recursive: true })
  await writeFile(
    join(agentDir, "auth.json"),
    `${JSON.stringify({
      openai: {
        type: "oauth",
        access: apiKey,
        refresh: "test-refresh-token",
        expires: Date.now() + 60 * 60 * 1000,
      },
    })}\n`,
  )
  if (initialConfig) {
    await writeFile(
      join(agentDir, "chatgpt.json"),
      `${JSON.stringify(initialConfig, null, 2)}\n`,
    )
  }

  const piArgs = buildPiArgs(model)
  if (runtimeApiKey) piArgs.push("--api-key", runtimeApiKey)

  const [command, args] = scriptCommand(outputFile, "pi", piArgs)
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      CHATGPT_BASE_URL: baseUrl,
      [trustEnvName]: "1",
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      TERM: "xterm-256color",
      NO_COLOR: "0",
      COLUMNS: "160",
      LINES: "40",
      // Assertions use only this child's owned PTY transcript.
      PI_TUI_DEBUG: "0",
      PI_TUI_WRITE_LOG: "",
      PI_CHATGPT_FAST: "0",
      PI_CHATGPT_SPEED: "standard",
      ...extraEnv,
    },
  })

  try {
    let output = await waitForOutput(outputFile, waitFor, timeoutMs)
    if (settleMs > 0) {
      await new Promise((resolveWait) => setTimeout(resolveWait, settleMs))
      output = await readIfExists(outputFile)
    }
    return { output, outputFile }
  } finally {
    try {
      process.kill(-child.pid, "SIGTERM")
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {}
    await rm(tempDir, { recursive: true, force: true })
  }
}

async function runRealPiTuiExpect({
  baseUrl,
  apiKey,
  mainKeys,
  optionKeys,
  submenuText,
  expectText,
  expectedConfig,
  expectedConfigWritten = true,
  initialConfig,
  scriptBody,
  commandText = "/chatgpt",
  settleMs = 100,
  extraEnv = {},
  timeoutMs = 12000,
}) {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-chatgpt-expect-"))
  const outputFile = join(tempDir, "expect.log")
  const expectFile = join(tempDir, "test.exp")
  const agentDir = join(tempDir, "agent")
  const sessionDir = join(tempDir, "sessions")
  await mkdir(agentDir, { recursive: true })
  await writeFile(
    join(agentDir, "auth.json"),
    `${JSON.stringify({
      openai: {
        type: "oauth",
        access: apiKey,
        refresh: "test-refresh-token",
        expires: Date.now() + 60 * 60 * 1000,
      },
    })}\n`,
  )
  if (initialConfig) {
    await writeFile(
      join(agentDir, "chatgpt.json"),
      `${JSON.stringify(initialConfig, null, 2)}\n`,
    )
  }

  const piArgs = buildPiArgs().map(tclDoubleQuote).join(" ")
  const env = {
    CHATGPT_BASE_URL: baseUrl,
    CHATGPT_TRUST_CUSTOM_BASE_URL: "1",
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    TERM: "xterm-256color",
    NO_COLOR: "0",
    COLUMNS: "160",
    LINES: "40",
    PI_TUI_DEBUG: "0",
    PI_TUI_WRITE_LOG: "",
    PI_CHATGPT_FAST: "0",
    PI_CHATGPT_SPEED: "standard",
    ...extraEnv,
  }
  const envLines = Object.entries(env)
    .map(([key, value]) => `set env(${key}) ${tclDoubleQuote(value)}`)
    .join("\n")

  const body =
    scriptBody ??
    `${expectBlock("Configure footer display mode")}
send "${expectSendLiteral(mainKeys)}"
${expectBlock(submenuText)}
send "${expectSendLiteral(optionKeys)}"
${expectBlock(expectText)}`

  await writeFile(
    expectFile,
    `log_file -noappend ${tclDoubleQuote(outputFile)}
set timeout ${Math.ceil(timeoutMs / 1000)}
${envLines}
spawn pi ${piArgs}
set pi_pid [exp_pid]
stty columns 160 rows 40
after 1500
send "${expectSendLiteral(commandText)}\\r"
${body}
after ${settleMs}
catch {exec kill -TERM $pi_pid}
after 100
catch {exec kill -KILL $pi_pid}
close
`,
  )

  try {
    const child = spawn("expect", [expectFile], {
      detached: true,
      stdio: "ignore",
    })
    const status = await new Promise((resolveClose) => {
      child.on("close", (code) => resolveClose(code))
    })
    const output = await readIfExists(outputFile)
    assert.equal(status, 0, output)
    if (expectedConfig) {
      assert.deepEqual(
        JSON.parse(await readFile(join(agentDir, "chatgpt.json"), "utf8")),
        expectedConfigWritten
          ? {
              ...expectedConfig,
              fastMode: expectedConfig.fastMode ?? false,
              speedMode:
                expectedConfig.speedMode ??
                (expectedConfig.fastMode ? "fast" : "standard"),
            }
          : expectedConfig,
      )
    }
    return output
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

test("waitForOutput rejects missing or unmatched output on timeout", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-chatgpt-poll-"))
  const outputFile = join(tempDir, "output.log")
  try {
    await assert.rejects(
      waitForOutput(outputFile, (text) => text.includes("ready"), 20),
      /Timed out after 20ms waiting for output/,
    )
    await writeFile(outputFile, "starting")
    await assert.rejects(
      waitForOutput(outputFile, (text) => text.includes("ready"), 20),
      /Timed out after 20ms waiting for output:\nstarting/,
    )
    await writeFile(outputFile, "ready")
    assert.equal(
      await waitForOutput(outputFile, (text) => text.includes("ready"), 20),
      "ready",
    )
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test("skips automatic footer and usage work outside TUI mode", async () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR
  const tempDir = await mkdtemp(join(tmpdir(), "pi-chatgpt-mode-"))
  process.env.PI_CODING_AGENT_DIR = tempDir

  try {
    for (const mode of ["rpc", "json", "print"]) {
      const handlers = new Map()
      let footerInstalls = 0
      let usageAuthCalls = 0

      extension({
        on(eventName, handler) {
          handlers.set(eventName, handler)
        },
        registerCommand() {},
      })

      const ctx = {
        mode,
        model: { provider: "openai", id: "gpt-5.5" },
        modelRegistry: {
          isUsingOAuth: () => true,
          getApiKeyAndHeaders: async () => {
            usageAuthCalls++
            return { ok: false }
          },
        },
        sessionManager: {
          getBranch: () => [],
        },
        ui: {
          setFooter: () => {
            footerInstalls++
          },
        },
      }

      await handlers.get("session_start")?.({}, ctx)
      handlers.get("model_select")?.({}, ctx)
      handlers.get("agent_end")?.({}, ctx)
      await new Promise((resolveWait) => setTimeout(resolveWait, 20))

      assert.equal(footerInstalls, 0, `${mode} should not install footer`)
      assert.equal(usageAuthCalls, 0, `${mode} should not fetch usage`)
    }
  } finally {
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir
    }
    await rm(tempDir, { recursive: true, force: true })
  }
})

test("installs footer when ctx.mode is unavailable but process looks interactive", async () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR
  const originalIsTTY = process.stdin.isTTY
  const tempDir = await mkdtemp(join(tmpdir(), "pi-chatgpt-fallback-"))
  process.env.PI_CODING_AGENT_DIR = tempDir
  Object.defineProperty(process.stdin, "isTTY", {
    value: true,
    configurable: true,
  })

  try {
    const handlers = new Map()
    let footerInstalls = 0
    let usageAuthCalls = 0

    extension({
      on(eventName, handler) {
        handlers.set(eventName, handler)
      },
      registerCommand() {},
    })

    const ctx = {
      model: { provider: "openai", id: "gpt-5.5" },
      modelRegistry: {
        isUsingOAuth: () => true,
        getApiKeyAndHeaders: async () => {
          usageAuthCalls++
          return { ok: false }
        },
      },
      sessionManager: {
        getBranch: () => [],
      },
      ui: {
        setFooter: () => {
          footerInstalls++
        },
      },
    }

    await handlers.get("session_start")?.({}, ctx)
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))

    assert.equal(footerInstalls, 1)
    assert.equal(usageAuthCalls, 1)
  } finally {
    if (originalIsTTY === undefined) {
      delete process.stdin.isTTY
    } else {
      Object.defineProperty(process.stdin, "isTTY", {
        value: originalIsTTY,
        configurable: true,
      })
    }
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir
    }
    await rm(tempDir, { recursive: true, force: true })
  }
})

test("parses usage snapshots and token metadata without a TUI", () => {
  const token = fakeJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_unit",
      chatgpt_plan_type: "pro",
    },
    "https://api.openai.com/profile": { email: "unit@example.com" },
  })

  assert.deepEqual(__test__.getTokenMetadata(token), {
    accountId: "acct_unit",
    planType: "pro",
    email: "unit@example.com",
  })

  const snapshot = __test__.parseUsageSnapshot({
    plan_type: "pro",
    rate_limit: {
      primary_window: {
        used_percent: 25.4,
        limit_window_seconds: 5 * 60 * 60,
        reset_at: 123,
      },
      secondary_window: {
        used_percent: 42.2,
        limit_window_seconds: 7 * 24 * 60 * 60,
        reset_at: 456,
      },
    },
  })

  assert.equal(snapshot.planType, "pro")
  assert.equal(snapshot.fiveHour.usedPercent, 25.4)
  assert.equal(snapshot.weekly.usedPercent, 42.2)
})

test("validates ChatGPT base URL before bearer token use", () => {
  assert.deepEqual(__test__.resolveChatGptBaseUrl(undefined), {
    ok: true,
    url: "https://chatgpt.com/backend-api",
    reason: undefined,
  })
  assert.equal(
    __test__.resolveChatGptBaseUrl("https://chatgpt.com/backend-api/").url,
    "https://chatgpt.com/backend-api",
  )
  assert.equal(
    __test__.resolveChatGptBaseUrl("http://chatgpt.com/backend-api").ok,
    false,
  )
  assert.equal(
    __test__.resolveChatGptBaseUrl("https://example.com/backend-api").ok,
    false,
  )
  assert.equal(
    __test__.resolveChatGptBaseUrl("http://127.0.0.1:123/backend-api", true)
      .url,
    "http://127.0.0.1:123/backend-api",
  )
})

test("normalizes config and formats percentages without a TUI", () => {
  assert.deepEqual(
    __test__.normalizeFooterConfig({
      quotaWindow: "both",
      displayMode: "pace",
    }),
    { quotaWindow: "both", displayMode: "pace" },
  )
  assert.deepEqual(
    __test__.normalizeFooterConfig({ quotaWindow: "bad", displayMode: "bad" }),
    { quotaWindow: "weekly", displayMode: "used" },
  )
  assert.deepEqual(__test__.normalizeGlobalConfig({ fastMode: true }), {
    quotaWindow: "weekly",
    displayMode: "used",
    fastMode: true,
    speedMode: "fast",
  })
  assert.deepEqual(
    __test__.normalizeGlobalConfig({
      fastMode: false,
      speedMode: "ultrafast",
    }),
    {
      quotaWindow: "weekly",
      displayMode: "used",
      fastMode: true,
      speedMode: "ultrafast",
    },
  )
  assert.equal(__test__.formatUsedPercent({ usedPercent: 42.6 }), "43%")
  assert.equal(__test__.formatRemainingPercent({ usedPercent: 42.2 }), "58%")
  assert.equal(__test__.isChatGptProvider("openai"), true)
  for (const provider of [
    "openai-codex",
    "openai-codex-2",
    "openai-codex-123",
    "openai-codex-responses",
    "openai-2",
    "anthropic",
    undefined,
  ]) {
    assert.equal(__test__.isChatGptProvider(provider), false)
    assert.equal(
      __test__.isFastSupportedModel({ provider, id: "gpt-5.5" }),
      false,
    )
    assert.equal(
      __test__.isUltrafastSupportedModel({ provider, id: "gpt-6-astra" }),
      false,
    )
  }
  const fastModelIds = [
    "gpt-5.4",
    "gpt-5.5",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]
  for (const id of fastModelIds) {
    assert.equal(
      __test__.isFastSupportedModel({ provider: "openai", id }),
      true,
    )
  }
  for (const id of ["gpt-5.4-mini", "gpt-5.6", "gpt-5.6-sun"]) {
    assert.equal(
      __test__.isFastSupportedModel({ provider: "openai", id }),
      false,
    )
  }
  assert.equal(
    __test__.isFastSupportedModel({ provider: "anthropic", id: "gpt-5.5" }),
    false,
  )
  assert.deepEqual(__test__.addFastServiceTier({ model: "gpt-5.5" }), {
    model: "gpt-5.5",
    service_tier: "priority",
  })
  assert.deepEqual(
    __test__.addSpeedServiceTier({ model: "gpt-6-astra" }, "ultrafast"),
    { model: "gpt-6-astra", service_tier: "ultrafast" },
  )
  assert.equal(__test__.addFastServiceTier(null), undefined)
  for (const id of ["gpt-6-astra", "gpt-6.1-sol"]) {
    assert.equal(
      __test__.isUltrafastSupportedModel({ provider: "openai", id }),
      true,
    )
  }
  for (const id of ["gpt-5.5", "gpt-6-sol", "gpt-6.1-sol-pro"]) {
    assert.equal(
      __test__.isUltrafastSupportedModel({ provider: "openai", id }),
      false,
    )
  }
  assert.equal(
    __test__.isUltrafastSupportedModel({
      provider: "openrouter",
      id: "gpt-6.1-sol",
    }),
    false,
  )
  assert.equal(__test__.parseFastEnv("1"), true)
  assert.equal(__test__.parseFastEnv("0"), false)
  assert.equal(__test__.parseFastEnv("true"), undefined)
  assert.equal(__test__.parseSpeedEnv("ULTRAFAST"), "ultrafast")
  assert.equal(__test__.parseSpeedEnv("turbo"), undefined)

  const ctx = {
    model: {
      provider: "openai",
      id: "gpt-5.5",
      contextWindow: 1000,
    },
    sessionManager: {
      getEntries: () => [],
      getCwd: () => "/tmp/project",
      getSessionName: () => undefined,
    },
    modelRegistry: { isUsingOAuth: () => true },
    getContextUsage: () => ({ contextWindow: 1000, percent: 10 }),
  }
  const footerData = {
    getGitBranch: () => undefined,
    getAvailableProviderCount: () => 1,
  }
  const theme = { fg: (_color, text) => text }
  const pi = { getThinkingLevel: () => "off" }
  for (const id of fastModelIds) {
    ctx.model.id = id
    assert.match(
      __test__.renderFooter(pi, ctx, footerData, theme, 120, "fast").join("\n"),
      new RegExp(`${id.replaceAll(".", "\\.")} • Fast`),
    )
  }
  ctx.model = {
    provider: "openai",
    id: "gpt-6-astra",
    contextWindow: 1000,
  }
  assert.match(
    __test__
      .renderFooter(pi, ctx, footerData, theme, 120, "ultrafast")
      .join("\n"),
    /gpt-6-astra • Ultrafast/,
  )
  ctx.model = {
    provider: "openai",
    id: "gpt-5.4-mini",
    contextWindow: 1000,
  }
  assert.doesNotMatch(
    __test__.renderFooter(pi, ctx, footerData, theme, 120, "fast").join("\n"),
    /Fast/,
  )
})

test("renders all live extension statuses in the top-right footer", () => {
  const ctx = {
    model: {
      provider: "openai",
      id: "gpt-5.6-sol",
      contextWindow: 1000,
    },
    sessionManager: {
      getEntries: () => [],
      getCwd: () => "/tmp/a-long-project-directory",
      getSessionName: () => "footer test",
    },
    modelRegistry: { isUsingOAuth: () => true },
    getContextUsage: () => ({ contextWindow: 1000, percent: 10 }),
  }
  const statuses = new Map()
  const footerData = {
    getGitBranch: () => "main",
    getAvailableProviderCount: () => 1,
    getExtensionStatuses: () => statuses,
  }
  const theme = { fg: (_color, text) => text }
  const pi = { getThinkingLevel: () => "high" }
  const width = 120
  const withoutStatus = __test__.renderFooter(pi, ctx, footerData, theme, width)
  const withoutStatusNarrow = __test__.renderFooter(
    pi,
    ctx,
    footerData,
    theme,
    32,
  )
  const alphaStatus = "\x1b[36mAlpha ready\x1b[0m"
  const zetaStatus = "\x1b[32mZeta online\x1b[0m"

  statuses.set("zeta", "\x1b[32mZeta\n online\x1b[0m")
  statuses.set("empty", " \r\n\t ")
  statuses.set("alpha", "\x1b[36mAlpha\t ready\x1b[0m")
  const withStatuses = __test__.renderFooter(pi, ctx, footerData, theme, width)
  assert.equal(withStatuses.length, 2)
  assert.equal(withStatuses[1], withoutStatus[1])
  assert.ok(
    withStatuses[0].startsWith(
      "/tmp/a-long-project-directory (main) • footer test",
    ),
  )
  assert.equal(visibleWidth(withStatuses[0]), width)
  assert.ok(withStatuses[0].endsWith(`${alphaStatus} ${zetaStatus}`))
  assert.doesNotMatch(stripAnsi(withStatuses[0]), /[\r\n\t]/)

  statuses.set("alpha", "\x1b[35mUpdated\x1b[0m")
  const updated = __test__.renderFooter(pi, ctx, footerData, theme, width)
  assert.ok(updated[0].endsWith(`\x1b[35mUpdated\x1b[0m ${zetaStatus}`))

  const narrow = __test__.renderFooter(pi, ctx, footerData, theme, 32)
  assert.equal(narrow.length, 2)
  assert.equal(narrow[1], withoutStatusNarrow[1])
  assert.equal(visibleWidth(narrow[0]), 32)
  assert.ok(stripAnsi(narrow[0]).startsWith("/tmp/a-long-...  "))
  assert.ok(stripAnsi(narrow[0]).endsWith("..."))

  const tooNarrow = __test__.renderFooter(pi, ctx, footerData, theme, 8)
  assert.equal(tooNarrow.length, 2)
  assert.ok(visibleWidth(tooNarrow[0]) <= 8)

  statuses.clear()
  statuses.set("empty", " \r\n\t ")
  assert.deepEqual(
    __test__.renderFooter(pi, ctx, footerData, theme, width),
    withoutStatus,
  )
})

test("detects TUI mode with context and process fallback", () => {
  const tuiCtx = { ui: { setFooter() {} } }

  assert.equal(
    __test__.isTuiContext({ ...tuiCtx, mode: "tui" }, ["-p"], false),
    true,
  )
  assert.equal(
    __test__.isTuiContext({ ...tuiCtx, mode: "interactive" }, ["-p"], false),
    true,
  )
  assert.equal(
    __test__.isTuiContext({ ...tuiCtx, mode: "rpc" }, [], true),
    false,
  )
  assert.equal(__test__.isTuiContext(tuiCtx, [], true), true)
  assert.equal(__test__.isTuiContext(tuiCtx, ["--mode", "rpc"], true), false)
  assert.equal(__test__.isTuiContext(tuiCtx, ["--mode=json"], true), false)
  assert.equal(__test__.isTuiContext(tuiCtx, ["--mode=paseo"], true), false)
  assert.equal(__test__.isTuiContext(tuiCtx, ["--print"], true), false)
  assert.equal(__test__.isTuiContext(tuiCtx, [], false), false)
  assert.equal(__test__.isTuiContext(tuiCtx, [], true, false), false)
  assert.equal(
    __test__.isTuiContext({ ...tuiCtx, hasUI: false }, [], true),
    false,
  )
})

test("speed commands migrate config, patch tiers, report support, and manage inheritance", async () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR
  const originalFast = process.env.PI_CHATGPT_FAST
  const originalSpeed = process.env.PI_CHATGPT_SPEED
  const tempDir = await mkdtemp(join(tmpdir(), "pi-chatgpt-fast-"))
  process.env.PI_CODING_AGENT_DIR = tempDir
  process.env.PI_CHATGPT_FAST = "0"
  delete process.env.PI_CHATGPT_SPEED
  await writeFile(
    join(tempDir, "chatgpt-limit.json"),
    `${JSON.stringify({ quotaWindow: "both", displayMode: "remaining" })}\n`,
  )

  try {
    const handlers = new Map()
    const commands = new Map()
    const notifications = []
    extension({
      on(eventName, handler) {
        handlers.set(eventName, handler)
      },
      registerCommand(name, command) {
        commands.set(name, command)
      },
    })

    const ctx = {
      mode: "rpc",
      model: { provider: "openai", id: "gpt-5.4" },
      modelRegistry: { isUsingOAuth: () => true },
      sessionManager: { getBranch: () => [] },
      ui: {
        notify: (message, type) => notifications.push({ message, type }),
      },
    }

    await handlers.get("session_start")?.({}, ctx)
    assert.deepEqual(
      JSON.parse(await readFile(join(tempDir, "chatgpt.json"), "utf8")),
      {
        quotaWindow: "both",
        displayMode: "remaining",
        fastMode: false,
        speedMode: "standard",
      },
    )
    assert.ok(commands.has("chatgpt"))
    assert.ok(commands.has("chatgpt-limit"))
    assert.equal(process.env.PI_CHATGPT_FAST, "0")
    assert.equal(process.env.PI_CHATGPT_SPEED, "standard")

    await commands.get("fast").handler("temporary", ctx)
    assert.equal(process.env.PI_CHATGPT_FAST, "1")
    assert.equal(process.env.PI_CHATGPT_SPEED, "fast")
    assert.deepEqual(
      handlers.get("before_provider_request")?.(
        { payload: { model: "gpt-5.4", service_tier: "default" } },
        ctx,
      ),
      { model: "gpt-5.4", service_tier: "priority" },
    )

    const invalidAgentDir = join(tempDir, "not-a-directory")
    await writeFile(invalidAgentDir, "")
    process.env.PI_CODING_AGENT_DIR = invalidAgentDir
    await assert.rejects(
      commands.get("fast").handler("persistent ultrafast", ctx),
    )
    assert.equal(process.env.PI_CHATGPT_FAST, "1")
    assert.equal(process.env.PI_CHATGPT_SPEED, "fast")
    process.env.PI_CODING_AGENT_DIR = tempDir

    ctx.model = { provider: "openai", id: "gpt-5.6-sol" }
    handlers.get("model_select")?.({ model: ctx.model }, ctx)
    await commands.get("fast").handler("temporary ultrafast", ctx)
    assert.equal(process.env.PI_CHATGPT_FAST, "0")
    assert.equal(process.env.PI_CHATGPT_SPEED, "ultrafast")
    assert.equal(
      handlers.get("before_provider_request")?.({ payload: {} }, ctx),
      undefined,
    )
    assert.match(
      notifications.at(-1).message,
      /Not active: openai\/gpt-5\.6-sol does not support Ultrafast mode.*gpt-6-astra and gpt-6\.1-sol only/,
    )
    assert.equal(notifications.at(-1).type, "warning")

    ctx.model = { provider: "openai", id: "gpt-6-astra" }
    handlers.get("model_select")?.({ model: ctx.model }, ctx)
    assert.equal(process.env.PI_CHATGPT_FAST, "1")
    assert.equal(process.env.PI_CHATGPT_SPEED, "ultrafast")
    assert.deepEqual(
      handlers.get("before_provider_request")?.(
        { payload: { model: "gpt-6-astra" } },
        ctx,
      ),
      { model: "gpt-6-astra", service_tier: "ultrafast" },
    )

    await commands.get("fast").handler("persistent ultrafast", ctx)
    assert.deepEqual(
      JSON.parse(await readFile(join(tempDir, "chatgpt.json"), "utf8")),
      {
        quotaWindow: "both",
        displayMode: "remaining",
        fastMode: true,
        speedMode: "ultrafast",
      },
    )

    ctx.model = { provider: "openai", id: "gpt-5.5" }
    handlers.get("model_select")?.({ model: ctx.model }, ctx)
    await commands.get("fast").handler("persistent", ctx)
    assert.equal(process.env.PI_CHATGPT_FAST, "1")
    assert.equal(process.env.PI_CHATGPT_SPEED, "fast")
    assert.equal(
      JSON.parse(await readFile(join(tempDir, "chatgpt.json"), "utf8"))
        .speedMode,
      "fast",
    )

    await commands.get("fast").handler("off", ctx)
    assert.equal(process.env.PI_CHATGPT_FAST, "0")
    assert.equal(process.env.PI_CHATGPT_SPEED, "standard")
    assert.deepEqual(
      JSON.parse(await readFile(join(tempDir, "chatgpt.json"), "utf8")),
      {
        quotaWindow: "both",
        displayMode: "remaining",
        fastMode: false,
        speedMode: "standard",
      },
    )
    await commands.get("fast").handler("status", ctx)
    assert.equal(
      notifications.at(-1).message,
      "ChatGPT speed: Standard (active).",
    )
    await commands.get("fast").handler("bad", ctx)
    assert.equal(
      notifications.at(-1).message,
      "Usage: /fast temporary|persistent [standard|fast|ultrafast] | off | status",
    )

    await handlers.get("session_shutdown")?.({}, ctx)
    assert.equal(process.env.PI_CHATGPT_FAST, "0")
    assert.equal(process.env.PI_CHATGPT_SPEED, undefined)

    process.env.PI_CHATGPT_SPEED = "ultrafast"
    const childHandlers = new Map()
    extension({
      on(eventName, handler) {
        childHandlers.set(eventName, handler)
      },
      registerCommand() {},
    })
    ctx.model = { provider: "openai", id: "gpt-6.1-sol" }
    await childHandlers.get("session_start")?.({}, ctx)
    // The inherited selection beats both legacy FAST=0 and persisted Standard.
    for (const id of [
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6.1-sol-pro",
      "gpt-6.1-sol",
    ]) {
      ctx.model.id = id
      childHandlers.get("model_select")({ model: ctx.model }, ctx)
      const supported = id === "gpt-6-astra" || id === "gpt-6.1-sol"
      assert.equal(process.env.PI_CHATGPT_FAST, supported ? "1" : "0")
      assert.equal(process.env.PI_CHATGPT_SPEED, "ultrafast")
      const payload = { model: id, service_tier: "default" }
      assert.deepEqual(
        childHandlers.get("before_provider_request")({ payload }, ctx),
        supported ? { ...payload, service_tier: "ultrafast" } : undefined,
      )
      assert.equal(payload.service_tier, "default")
    }
    ctx.modelRegistry.isUsingOAuth = () => false
    childHandlers.get("model_select")({ model: ctx.model }, ctx)
    assert.equal(process.env.PI_CHATGPT_FAST, "0")
    assert.equal(process.env.PI_CHATGPT_SPEED, "ultrafast")
    assert.equal(
      childHandlers.get("before_provider_request")({ payload: {} }, ctx),
      undefined,
    )
    await childHandlers.get("session_shutdown")?.({}, ctx)
    assert.equal(process.env.PI_CHATGPT_FAST, "0")
    assert.equal(process.env.PI_CHATGPT_SPEED, "ultrafast")
  } finally {
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir
    }
    if (originalFast === undefined) {
      delete process.env.PI_CHATGPT_FAST
    } else {
      process.env.PI_CHATGPT_FAST = originalFast
    }
    if (originalSpeed === undefined) {
      delete process.env.PI_CHATGPT_SPEED
    } else {
      process.env.PI_CHATGPT_SPEED = originalSpeed
    }
    await rm(tempDir, { recursive: true, force: true })
  }
})

test("unified openai OAuth supports speed modes and usage, but API keys do not", async (t) => {
  const originalEnv = { ...process.env }
  const tempDir = await mkdtemp(join(tmpdir(), "pi-chatgpt-openai-"))
  await writeFile(
    join(tempDir, "chatgpt.json"),
    JSON.stringify({ quotaWindow: "both", displayMode: "compact" }),
  )
  process.env.PI_CODING_AGENT_DIR = tempDir
  delete process.env.PI_CHATGPT_SPEED
  delete process.env.PI_CHATGPT_FAST
  const handlers = new Map()
  const commands = new Map()
  const notifications = []
  const menus = []
  let oauth = true
  let authCalls = 0
  let httpStatus = 200
  let token = fakeJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_unified" },
  })
  const fetchMock = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://chatgpt.com/backend-api/wham/usage")
    assert.equal(options.headers.Authorization, `Bearer ${token}`)
    if (httpStatus !== 200)
      return new Response("private server error", { status: httpStatus })
    return new Response(
      JSON.stringify({
        plan_type: "enterprise",
        rate_limit: {
          primary_window: {
            used_percent: 42,
            limit_window_seconds: 7 * 24 * 60 * 60,
          },
        },
      }),
    )
  })
  // Pi 0.99.1's unified catalog keeps this shape for both OAuth and API keys.
  const ctx = {
    mode: "rpc",
    model: {
      provider: "openai",
      id: "gpt-6.1-sol",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      contextWindow: 272000,
    },
    modelRegistry: {
      isUsingOAuth: () => oauth,
      getApiKeyAndHeaders: async () => {
        authCalls++
        return { ok: true, apiKey: oauth ? token : "test-api-key" }
      },
    },
    sessionManager: {
      getBranch: () => [],
      getEntries: () => [],
      getCwd: () => "/tmp/project",
      getSessionName: () => undefined,
    },
    getContextUsage: () => ({ contextWindow: 272000, percent: 0 }),
    ui: {
      notify: (message, type) => notifications.push({ message, type }),
      select: async (_title, options) => {
        menus.push(options)
        return options[0]
      },
    },
  }
  const footer = () =>
    __test__
      .renderFooter(
        {},
        ctx,
        { getGitBranch: () => undefined, getAvailableProviderCount: () => 1 },
        { fg: (_color, text) => text },
        160,
        process.env.PI_CHATGPT_SPEED,
      )
      .join("\n")
  extension({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
  })
  try {
    await handlers.get("session_start")({}, ctx)
    await commands.get("fast").handler("persistent ultrafast", ctx)
    assert.deepEqual(notifications.at(-1), {
      message: "Ultrafast mode selected persistently.",
      type: "info",
    })
    assert.equal(process.env.PI_CHATGPT_FAST, "1")
    assert.equal(process.env.PI_CHATGPT_SPEED, "ultrafast")
    assert.equal(
      JSON.parse(await readFile(join(tempDir, "chatgpt.json"), "utf8"))
        .speedMode,
      "ultrafast",
    )
    await commands.get("fast").handler("status", ctx)
    assert.equal(
      notifications.at(-1).message,
      "ChatGPT speed: Ultrafast (active).",
    )
    const payload = { model: "gpt-6.1-sol", service_tier: "default" }
    assert.deepEqual(
      handlers.get("before_provider_request")({ payload }, ctx),
      {
        ...payload,
        service_tier: "ultrafast",
      },
    )
    assert.equal(payload.service_tier, "default")
    assert.match(footer(), /Ultrafast/)
    await commands.get("chatgpt").handler("", ctx)
    assert.ok(menus.at(-1).includes("provider: openai"))
    assert.ok(menus.at(-1).includes("plan: enterprise"))
    assert.match(footer(), /W 42%/)
    await handlers.get("session_start")({}, ctx)
    assert.equal(process.env.PI_CHATGPT_SPEED, "ultrafast")
    assert.equal(process.env.PI_CHATGPT_FAST, "1")

    for (const id of [
      "gpt-5.4",
      "gpt-5.5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]) {
      ctx.model.id = id
      handlers.get("model_select")({ model: ctx.model }, ctx)
      assert.equal(process.env.PI_CHATGPT_FAST, "0")
      assert.equal(
        handlers.get("before_provider_request")({ payload: {} }, ctx),
        undefined,
      )
      assert.doesNotMatch(footer(), /Ultrafast/)
      await commands.get("fast").handler("temporary fast", ctx)
      assert.equal(notifications.at(-1).type, "info")
      assert.equal(process.env.PI_CHATGPT_FAST, "1")
      assert.equal(
        handlers.get("before_provider_request")({ payload: {} }, ctx)
          .service_tier,
        "priority",
      )
      assert.match(footer(), /Fast/)
      await commands.get("fast").handler("temporary ultrafast", ctx)
      assert.equal(notifications.at(-1).type, "warning")
    }
    oauth = false
    for (const [id, mode] of [
      ["gpt-6-astra", "ultrafast"],
      ["gpt-6.1-sol", "ultrafast"],
      ["gpt-5.5", "fast"],
    ]) {
      ctx.model.id = id
      await commands.get("fast").handler(`temporary ${mode}`, ctx)
      assert.equal(notifications.at(-1).type, "warning")
      assert.match(notifications.at(-1).message, /ChatGPT OAuth/)
      assert.equal(process.env.PI_CHATGPT_FAST, "0")
      assert.equal(
        handlers.get("before_provider_request")({ payload: {} }, ctx),
        undefined,
      )
      assert.doesNotMatch(footer(), /Ultrafast|Fast|W 42%/)
      await commands.get("chatgpt").handler("", ctx)
    }
    ctx.mode = "tui"
    ctx.ui.setFooter = () => {}
    await handlers.get("session_start")({}, ctx)
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    assert.equal(authCalls, 1)
    assert.equal(fetchMock.mock.callCount(), 1)

    // Usage must work in Standard mode and resolve credentials on every refresh.
    oauth = true
    await commands.get("fast").handler("temporary standard", ctx)
    for (const event of ["model_select", "agent_end"]) {
      token = `test-refreshed-${event}`
      handlers.get(event)({ model: ctx.model }, ctx)
      await new Promise(setImmediate)
      assert.match(footer(), /W 42%/)
      assert.doesNotMatch(footer(), /Ultrafast|Fast/)
    }
    await commands.get("chatgpt-limit").handler("", ctx)
    assert.ok(menus.at(-1).includes("provider: openai"))
    assert.equal(authCalls, 4)
    assert.equal(fetchMock.mock.callCount(), 4)

    // Excluded providers cannot fetch, accelerate, or display cached quota.
    for (const provider of ["openai-codex", "openai-codex-2", "anthropic"]) {
      ctx.model.provider = provider
      for (const [id, mode] of [
        ["gpt-5.5", "fast"],
        ["gpt-6-astra", "ultrafast"],
        ["gpt-6.1-sol", "ultrafast"],
      ]) {
        ctx.model.id = id
        await commands.get("fast").handler(`temporary ${mode}`, ctx)
        assert.equal(notifications.at(-1).type, "warning")
        assert.match(notifications.at(-1).message, /via \/login on openai\./)
        await commands.get("fast").handler("status", ctx)
        assert.match(
          notifications.at(-1).message,
          /selected; requires ChatGPT OAuth via \/login on openai/,
        )
        assert.equal(process.env.PI_CHATGPT_FAST, "0")
        assert.equal(process.env.PI_CHATGPT_SPEED, mode)
        assert.equal(
          handlers.get("before_provider_request")({ payload }, ctx),
          undefined,
        )
        assert.equal(payload.service_tier, "default")
        assert.doesNotMatch(footer(), /Ultrafast|Fast|W 42%/)
        for (const command of ["chatgpt", "chatgpt-limit"]) {
          await commands.get(command).handler("", ctx)
          assert.equal(
            notifications.at(-1).message,
            "ChatGPT limits require an openai model authenticated with ChatGPT OAuth via /login.",
          )
        }
      }
      await handlers.get("session_start")({}, ctx)
      handlers.get("model_select")({ model: ctx.model }, ctx)
      handlers.get("agent_end")({}, ctx)
      await new Promise(setImmediate)
      assert.equal(authCalls, 4)
      assert.equal(fetchMock.mock.callCount(), 4)
    }

    // Transport API names do not determine provider or OAuth eligibility.
    ctx.model.provider = "openai"
    ctx.model.api = "openai-codex-responses"
    await commands.get("fast").handler("temporary ultrafast", ctx)
    assert.equal(process.env.PI_CHATGPT_FAST, "1")
    assert.equal(
      handlers.get("before_provider_request")({ payload }, ctx).service_tier,
      "ultrafast",
    )
    await commands.get("chatgpt").handler("", ctx)
    assert.match(footer(), /Ultrafast.*W 42%/)
    assert.equal(ctx.model.api, "openai-codex-responses")
    assert.equal(authCalls, 5)
    assert.equal(fetchMock.mock.callCount(), 5)
    oauth = false
    await commands.get("chatgpt").handler("", ctx)
    assert.equal(
      handlers.get("before_provider_request")({ payload }, ctx),
      undefined,
    )
    assert.equal(fetchMock.mock.callCount(), 5)
    assert.doesNotMatch(footer(), /Ultrafast|W 42%/)
    oauth = true
    ctx.model.api = "openai-responses"
    for (const status of [401, 403, 429, 500]) {
      httpStatus = status
      await commands.get("chatgpt").handler("", ctx)
      assert.deepEqual(notifications.at(-1), {
        message: `Could not load ChatGPT usage limits (HTTP ${status}).`,
        type: "warning",
      })
      assert.ok(footer().includes(`Usage: HTTP ${status}`))
      assert.doesNotMatch(footer(), /W 42%|private server error/)
      oauth = false
      assert.doesNotMatch(footer(), /Usage: HTTP/)
      oauth = true
    }
    httpStatus = 200
    await commands.get("chatgpt").handler("", ctx)
    assert.match(footer(), /W 42%/)
    assert.doesNotMatch(footer(), /5h|Usage: HTTP/)
  } finally {
    await handlers.get("session_shutdown")({}, ctx)
    for (const name of [
      "PI_CODING_AGENT_DIR",
      "PI_CHATGPT_SPEED",
      "PI_CHATGPT_FAST",
    ]) {
      if (originalEnv[name] === undefined) delete process.env[name]
      else process.env[name] = originalEnv[name]
    }
    await rm(tempDir, { recursive: true, force: true })
  }
})

test("RPC fallback configures footer when custom UI is unavailable", async () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR
  const tempDir = await mkdtemp(join(tmpdir(), "pi-chatgpt-rpc-"))
  process.env.PI_CODING_AGENT_DIR = tempDir

  try {
    const handlers = new Map()
    let command
    let customCalls = 0
    const notifications = []
    const selectResponses = []

    extension({
      on(eventName, handler) {
        handlers.set(eventName, handler)
      },
      registerCommand(name, registeredCommand) {
        if (name === "chatgpt") command = registeredCommand
      },
    })

    const ctx = {
      mode: "rpc",
      sessionManager: { getBranch: () => [] },
      ui: {
        custom: async () => {
          customCalls++
          return undefined
        },
        select: async (_title, options) => {
          const response = selectResponses.shift()
          return typeof response === "function" ? response(options) : response
        },
        notify: (message) => notifications.push(message),
        confirm: async () => false,
      },
    }

    await handlers.get("session_start")?.({}, ctx)

    selectResponses.push(
      (options) =>
        options.find((option) => option.startsWith("Configure footer limit")),
      "Both 5-hour and weekly",
    )
    await command.handler([], ctx)
    assert.deepEqual(
      JSON.parse(await readFile(join(tempDir, "chatgpt.json"), "utf8")),
      {
        quotaWindow: "both",
        displayMode: "used",
        fastMode: false,
        speedMode: "standard",
      },
    )

    selectResponses.push(
      "Configure footer display mode",
      "Remaining percent, e.g. W 58% left",
    )
    await command.handler([], ctx)
    assert.deepEqual(
      JSON.parse(await readFile(join(tempDir, "chatgpt.json"), "utf8")),
      {
        quotaWindow: "both",
        displayMode: "remaining",
        fastMode: false,
        speedMode: "standard",
      },
    )
    assert.equal(customCalls, 2)
    assert.deepEqual(notifications, [
      "ChatGPT footer display: Both 5-hour and weekly",
      "ChatGPT footer mode: Remaining percent, e.g. W 58% left",
    ])
  } finally {
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir
    }
    await rm(tempDir, { recursive: true, force: true })
  }
})

test(
  "real pi TUI renders the ChatGPT weekly percentage in the footer",
  { skip: SCRIPT_SKIP },
  async () => {
    const token = fakeJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_test",
        chatgpt_plan_type: "pro",
      },
      "https://api.openai.com/profile": {
        email: "user@example.com",
      },
    })

    const server = await startUsageServer((req, res) => {
      assert.equal(req.url, "/backend-api/wham/usage")
      assert.equal(req.headers.authorization, `Bearer ${token}`)
      assert.equal(req.headers["chatgpt-account-id"], "acct_test")

      sendUsageResponse(res, {
        planType: "pro",
        fiveHourUsed: 25.4,
        weeklyUsed: 42.2,
        fiveHourResetSeconds: 3600,
        weeklyResetSeconds: 86400,
      })
    })

    try {
      const { output } = await runRealPiTui({
        baseUrl: server.baseUrl,
        apiKey: token,
      })

      assert.ok(
        server.requests.length > 0,
        "expected real pi extension to call the mocked ChatGPT usage API",
      )
      assert.match(output, /gpt-5\.5/)
      assert.match(output, /42%/)
    } finally {
      await server.close()
    }
  },
)

test(
  "real pi unified openai Sol 6.1 inherits Ultrafast only with OAuth",
  { skip: SCRIPT_SKIP },
  async () => {
    const token = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_sol" },
    })
    const server = await startUsageServer((_req, res) => sendUsageResponse(res))
    try {
      const options = {
        baseUrl: server.baseUrl,
        apiKey: token,
        model: "gpt-6.1-sol",
        extraEnv: { PI_CHATGPT_SPEED: "ultrafast" },
      }
      const { output } = await runRealPiTui({
        ...options,
        waitFor: (text) =>
          stripAnsi(text).includes("Ultrafast") &&
          stripAnsi(text).includes("W 42%"),
      })
      assert.match(stripAnsi(output), /Ultrafast/)
      assert.match(stripAnsi(output), /W 42%/)
      assert.ok(server.requests.length > 0)
      const requestCount = server.requests.length
      const apiKeyRun = await runRealPiTui({
        ...options,
        runtimeApiKey: "test-api-key",
        waitFor: (text) => stripAnsi(text).includes("gpt-6.1-sol"),
        settleMs: 500,
      })
      assert.match(stripAnsi(apiKeyRun.output), /gpt-6\.1-sol/)
      assert.doesNotMatch(stripAnsi(apiKeyRun.output), /Ultrafast|W 42%/)
      assert.equal(server.requests.length, requestCount)
    } finally {
      await server.close()
    }
  },
)

test(
  "real pi TUI shows quota rejection and supports weekly-only plans",
  { skip: SCRIPT_SKIP },
  async (t) => {
    const token = fakeJwt({})
    for (const status of [401, 200]) {
      await t.test(`HTTP ${status}`, async () => {
        const server = await startUsageServer((_req, res) => {
          res.writeHead(status, { "content-type": "application/json" })
          res.end(
            JSON.stringify(
              status === 401
                ? { error: "private server error" }
                : {
                    rate_limit: {
                      primary_window: {
                        used_percent: 42,
                        limit_window_seconds: 604800,
                        reset_at: Math.floor(Date.now() / 1000) + 86400,
                      },
                      secondary_window: null,
                    },
                  },
            ),
          )
        })
        try {
          const expected = status === 401 ? "Usage: HTTP 401" : "W 42%"
          const { output } = await runRealPiTui({
            baseUrl: server.baseUrl,
            apiKey: token,
            model: "gpt-6-astra",
            initialConfig: { quotaWindow: "both", displayMode: "compact" },
            waitFor: (text) => stripAnsi(text).includes(expected),
          })
          assert.ok(server.requests.length > 0)
          assert.ok(stripAnsi(output).includes(expected))
          assert.doesNotMatch(stripAnsi(output), /5h \d+%|private server error/)
        } finally {
          await server.close()
        }
      })
    }
  },
)

test(
  "real pi TUI shows Fast only when effective",
  { skip: EXPECT_SKIP },
  async () => {
    const token = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_fast" },
    })
    const server = await startUsageServer((_req, res) => {
      sendUsageResponse(res)
    })

    try {
      const output = await runRealPiTuiExpect({
        baseUrl: server.baseUrl,
        apiKey: token,
        commandText: "/fast temporary",
        scriptBody: `${expectBlock("Fast mode enabled temporarily.")}
${expectBlock("Fast")}`,
      })
      assert.match(stripAnsi(output), /Fast/)
    } finally {
      await server.close()
    }
  },
)

test(
  "real pi TUI loads global footer configuration",
  { skip: SCRIPT_SKIP },
  async (t) => {
    const token = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_global" },
    })
    let successfulResponses = 0
    const server = await startUsageServer((req, res) => {
      assert.equal(req.url, "/backend-api/wham/usage")
      assert.equal(req.headers.authorization, `Bearer ${token}`)
      sendUsageResponse(res)
      successfulResponses++
    })

    try {
      await t.test("custom display", async () => {
        const { output } = await runRealPiTui({
          baseUrl: server.baseUrl,
          apiKey: token,
          initialConfig: { quotaWindow: "both", displayMode: "remaining" },
          waitFor: (text) =>
            stripAnsi(text).includes("5h 75% left / W 58% left"),
        })

        assert.match(stripAnsi(output), /5h 75% left \/ W 58% left/)
      })

      await t.test("hidden display", async () => {
        const responseCount = successfulResponses
        const { output } = await runRealPiTui({
          baseUrl: server.baseUrl,
          apiKey: token,
          initialConfig: { quotaWindow: "hidden", displayMode: "used" },
          waitFor: (text) =>
            successfulResponses > responseCount &&
            stripAnsi(text).includes("gpt-5.5") &&
            stripAnsi(text).includes("(sub)"),
          settleMs: 500,
        })

        assert.match(stripAnsi(output), /gpt-5\.5/)
        assert.match(stripAnsi(output), /\(sub\)/)
        assert.ok(successfulResponses > responseCount)
        assert.doesNotMatch(stripAnsi(output), /W 42%|5h 25%/)
      })
    } finally {
      await server.close()
    }
  },
)

test(
  "real pi TUI cancels footer previews and resets defaults",
  { skip: EXPECT_SKIP },
  async () => {
    const down = "\\033\\[B"
    const enter = "\\r"
    const escape = "\\033"
    const displayModeMenu = `${down}${down}${enter}`
    const resetMenu = `${down}${down}${down}${enter}`
    const defaultConfig = { quotaWindow: "weekly", displayMode: "used" }
    const token = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_reset" },
    })
    const server = await startUsageServer((_req, res) => {
      sendUsageResponse(res)
    })

    try {
      const previewOutput = await runRealPiTuiExpect({
        baseUrl: server.baseUrl,
        apiKey: token,
        initialConfig: defaultConfig,
        expectedConfig: defaultConfig,
        expectedConfigWritten: false,
        // Match the footer's separator, not the identical example in the menu.
        scriptBody: `${expectBlock("Configure footer display mode")}
send "${expectSendLiteral(displayModeMenu)}"
${expectBlock("How should the footer value be shown?")}
send "${expectSendLiteral(down)}"
expect {
  -re ${tclDoubleQuote("• (?:\\x1b\\[[0-9;]*m)*W 42% · ~2d")} {}
  timeout { exit 1 }
  eof { exit 1 }
}
send "${expectSendLiteral(escape)}"
expect {
  -re ${tclDoubleQuote("• (?:\\x1b\\[[0-9;]*m)*W 42%\\x1b")} {}
  timeout { exit 1 }
  eof { exit 1 }
}`,
      })
      const previewText = stripAnsi(previewOutput)
      const previewIndex = previewText.lastIndexOf("W 42% · ~2d")
      assert.ok(previewIndex >= 0, previewText)
      assert.ok(previewText.lastIndexOf("W 42%") > previewIndex, previewText)

      const resetOutput = await runRealPiTuiExpect({
        baseUrl: server.baseUrl,
        apiKey: token,
        initialConfig: { quotaWindow: "both", displayMode: "remainingCompact" },
        expectedConfig: defaultConfig,
        scriptBody: `${expectBlock("Reset footer settings to defaults")}
send "${expectSendLiteral(resetMenu)}"
${expectBlock("Reset ChatGPT footer settings?")}
send "${expectSendLiteral(enter)}"
${expectBlock("ChatGPT footer settings reset to defaults.")}`,
      })
      assert.match(stripAnsi(resetOutput), /settings reset to defaults/)
    } finally {
      await server.close()
    }
  },
)

test(
  "real pi TUI previews and saves footer display configuration options",
  { skip: EXPECT_SKIP },
  async (t) => {
    const down = "\\033\\[B"
    const enter = "\\r"
    const displayModeMenu = `${down}${down}${enter}`
    const footerLimitMenu = `${down}${enter}`
    const cases = [
      {
        name: "5-hour limit",
        mainKeys: footerLimitMenu,
        optionKeys: `${down}${enter}`,
        submenuText: "Display which ChatGPT limit in footer?",
        expectText: "ChatGPT footer display: 5-hour usage",
        expectedConfig: { quotaWindow: "fiveHour", displayMode: "used" },
      },
      {
        name: "both 5-hour and weekly limits",
        mainKeys: footerLimitMenu,
        optionKeys: `${down}${down}${enter}`,
        submenuText: "Display which ChatGPT limit in footer?",
        expectText: "ChatGPT footer display: Both 5-hour and weekly",
        expectedConfig: { quotaWindow: "both", displayMode: "used" },
      },
      {
        name: "hidden footer limit",
        mainKeys: footerLimitMenu,
        optionKeys: `${down}${down}${down}${enter}`,
        submenuText: "Display which ChatGPT limit in footer?",
        expectText:
          "ChatGPT footer display: Hide usage from footer (usage hidden).",
        expectedConfig: { quotaWindow: "hidden", displayMode: "used" },
      },
      {
        name: "used percent with reset",
        mainKeys: displayModeMenu,
        optionKeys: `${down}${enter}`,
        submenuText: "How should the footer value be shown?",
        expectText:
          "ChatGPT footer mode: Used percent with reset, e.g. W 42% · ~2d",
        expectedConfig: { quotaWindow: "weekly", displayMode: "compact" },
      },
      {
        name: "pace percent with state",
        mainKeys: displayModeMenu,
        optionKeys: `${down}${down}${enter}`,
        submenuText: "How should the footer value be shown?",
        expectText:
          "ChatGPT footer mode: Pace percent with state, e.g. WP 13% (reserve)",
        expectedConfig: { quotaWindow: "weekly", displayMode: "pace" },
      },
      {
        name: "pace percent",
        mainKeys: displayModeMenu,
        optionKeys: `${down}${down}${down}${enter}`,
        submenuText: "How should the footer value be shown?",
        expectText: "ChatGPT footer mode: Pace percent, e.g. WP -13%",
        expectedConfig: { quotaWindow: "weekly", displayMode: "paceCompact" },
      },
      {
        name: "pace percent with reset",
        mainKeys: displayModeMenu,
        optionKeys: `${down}${down}${down}${down}${enter}`,
        submenuText: "How should the footer value be shown?",
        expectText:
          "ChatGPT footer mode: Pace percent with reset, e.g. WP -13% · ~2d",
        expectedConfig: {
          quotaWindow: "weekly",
          displayMode: "paceResetCompact",
        },
      },
      {
        name: "remaining percent",
        mainKeys: displayModeMenu,
        optionKeys: `${down}${down}${down}${down}${down}${enter}`,
        submenuText: "How should the footer value be shown?",
        expectText: "ChatGPT footer mode: Remaining percent, e.g. W 58% left",
        expectedConfig: { quotaWindow: "weekly", displayMode: "remaining" },
      },
      {
        name: "remaining percent with reset",
        mainKeys: displayModeMenu,
        optionKeys: `${down}${down}${down}${down}${down}${down}${enter}`,
        submenuText: "How should the footer value be shown?",
        expectText:
          "ChatGPT footer mode: Remaining percent with reset, e.g. W 58% left · ~2d",
        expectedConfig: {
          quotaWindow: "weekly",
          displayMode: "remainingCompact",
        },
      },
    ]

    for (const testCase of cases) {
      await t.test(testCase.name, async () => {
        const token = fakeJwt({
          "https://api.openai.com/auth": { chatgpt_account_id: "acct_config" },
        })
        const server = await startUsageServer((_req, res) => {
          sendUsageResponse(res)
        })

        try {
          await runRealPiTuiExpect({
            baseUrl: server.baseUrl,
            apiKey: token,
            mainKeys: testCase.mainKeys,
            optionKeys: testCase.optionKeys,
            submenuText: testCase.submenuText,
            expectText: testCase.expectText,
            expectedConfig: testCase.expectedConfig,
          })
        } finally {
          await server.close()
        }
      })
    }
  },
)

test(
  "real pi TUI still fetches usage when PI_OFFLINE is set",
  { skip: SCRIPT_SKIP },
  async () => {
    const token = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_offline" },
    })

    const server = await startUsageServer((_req, res) => {
      sendUsageResponse(res, {
        fiveHourUsed: 1,
        fiveHourResetSeconds: 3600,
        weeklyResetSeconds: 86400,
      })
    })

    try {
      const { output } = await runRealPiTui({
        baseUrl: server.baseUrl,
        apiKey: token,
        extraEnv: { PI_OFFLINE: "1" },
        trustEnvName: "CHATGPT_LIMIT_TRUST_CUSTOM_BASE_URL",
      })

      assert.ok(
        server.requests.length > 0,
        `expected usage fetch even when PI_OFFLINE=1; output was:\n${output}`,
      )
    } finally {
      await server.close()
    }
  },
)
