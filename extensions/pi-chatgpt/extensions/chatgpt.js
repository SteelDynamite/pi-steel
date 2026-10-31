/**
 * Add ChatGPT Codex usage and speed mode support to pi.
 *
 * Uses ChatGPT's usage endpoint:
 *   GET https://chatgpt.com/backend-api/wham/usage
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { stripVTControlCharacters } from "node:util"

import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui"

const DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api"
const TRUST_CUSTOM_BASE_URL_ENV = "CHATGPT_TRUST_CUSTOM_BASE_URL"
const LEGACY_TRUST_CUSTOM_BASE_URL_ENV = "CHATGPT_LIMIT_TRUST_CUSTOM_BASE_URL"
const FAST_ENV = "PI_CHATGPT_FAST"
const SPEED_ENV = "PI_CHATGPT_SPEED"
const ALLOWED_CHATGPT_ORIGINS = new Set(["https://chatgpt.com"])
const CHATGPT_BASE_URL_RESULT = resolveChatGptBaseUrl(
  process.env.CHATGPT_BASE_URL,
  parseBooleanEnv(
    process.env[TRUST_CUSTOM_BASE_URL_ENV] ??
      process.env[LEGACY_TRUST_CUSTOM_BASE_URL_ENV],
  ),
)
const CHATGPT_BASE_URL = CHATGPT_BASE_URL_RESULT.url
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth"
const OPENAI_PROFILE_CLAIM = "https://api.openai.com/profile"
const FIVE_HOUR_SECONDS = 5 * 60 * 60
const WEEK_SECONDS = 7 * 24 * 60 * 60
const LEGACY_CONFIG_ENTRY_TYPE = "chatgpt-limit-config"
const CONFIG_FILE_NAME = "chatgpt.json"
const LEGACY_CONFIG_FILE_NAME = "chatgpt-limit.json"
const STANDARD_MODE = "standard"
const FAST_MODE = "fast"
const ULTRAFAST_MODE = "ultrafast"
const SPEED_MODES = new Set([STANDARD_MODE, FAST_MODE, ULTRAFAST_MODE])
const SPEED_MODE_LABELS = {
  [STANDARD_MODE]: "Standard",
  [FAST_MODE]: "Fast",
  [ULTRAFAST_MODE]: "Ultrafast",
}
const FAST_SUPPORTED_MODELS = new Set([
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
])
const ULTRAFAST_SUPPORTED_MODELS = new Set(["gpt-6-astra", "gpt-6.1-sol"])

const DEFAULT_FOOTER_CONFIG = {
  quotaWindow: "weekly",
  displayMode: "used",
}
const CUSTOM_CONFIG_CANCELLED = Symbol("custom config cancelled")

const QUOTA_WINDOW_OPTIONS = [
  { label: "Weekly usage (default)", value: "weekly" },
  { label: "5-hour usage", value: "fiveHour" },
  { label: "Both 5-hour and weekly", value: "both" },
  { label: "Hide usage from footer", value: "hidden" },
]

const DISPLAY_MODE_OPTIONS = [
  { label: "Used percent, e.g. W 42%", value: "used" },
  { label: "Used percent with reset, e.g. W 42% · ~2d", value: "compact" },
  { label: "Pace percent with state, e.g. WP 13% (reserve)", value: "pace" },
  { label: "Pace percent, e.g. WP -13%", value: "paceCompact" },
  {
    label: "Pace percent with reset, e.g. WP -13% · ~2d",
    value: "paceResetCompact",
  },
  { label: "Remaining percent, e.g. W 58% left", value: "remaining" },
  {
    label: "Remaining percent with reset, e.g. W 58% left · ~2d",
    value: "remainingCompact",
  },
]

let usageSnapshot
let footerConfig = { ...DEFAULT_FOOTER_CONFIG }
let persistentSpeedMode = STANDARD_MODE
let requestRender = () => {}

/** @param {string} value */
function terminalText(value) {
  // Strip recognized escapes and remaining C0/C1 controls, including partial escapes.
  return stripVTControlCharacters(value).replace(
    /[\u0000-\u001f\u007f-\u009f]/g,
    "",
  )
}

/** @param {string | undefined} value */
function parseBooleanEnv(value) {
  return /^(1|true|yes)$/i.test(value || "")
}

/**
 * @param {string | undefined} value
 * @param {boolean} trustCustomBaseUrl
 */
function resolveChatGptBaseUrl(value, trustCustomBaseUrl = false) {
  const rawValue = value || DEFAULT_CHATGPT_BASE_URL
  let url

  try {
    url = new URL(rawValue)
  } catch {
    return {
      ok: false,
      url: undefined,
      reason: "CHATGPT_BASE_URL must be an absolute URL.",
    }
  }

  if (trustCustomBaseUrl) {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return {
        ok: false,
        url: undefined,
        reason: "Trusted custom CHATGPT_BASE_URL must use http: or https:.",
      }
    }
  } else {
    if (url.protocol !== "https:") {
      return {
        ok: false,
        url: undefined,
        reason: "CHATGPT_BASE_URL must use https:.",
      }
    }
    if (!ALLOWED_CHATGPT_ORIGINS.has(url.origin)) {
      return {
        ok: false,
        url: undefined,
        reason: `${url.origin} is not an allowed ChatGPT origin. Set ${TRUST_CUSTOM_BASE_URL_ENV}=1 only for trusted proxies/testing.`,
      }
    }
  }

  return { ok: true, url: url.href.replace(/\/+$/, ""), reason: undefined }
}

/** @param {string | undefined} provider */
function isChatGptProvider(provider) {
  return provider === "openai"
}

function isChatGptModel(model, modelRegistry) {
  // Unified OpenAI uses the same API and base URL for OAuth and API keys.
  return isChatGptProvider(model?.provider) && modelRegistry.isUsingOAuth(model)
}

/** @param {{ provider?: string, id?: string } | undefined} model */
function isFastSupportedModel(model) {
  return (
    isChatGptProvider(model?.provider) &&
    FAST_SUPPORTED_MODELS.has(model?.id || "")
  )
}

/** @param {{ provider?: string, id?: string } | undefined} model */
function isUltrafastSupportedModel(model) {
  return (
    isChatGptProvider(model?.provider) &&
    ULTRAFAST_SUPPORTED_MODELS.has(model?.id || "")
  )
}

/**
 * @param {{ provider?: string, id?: string } | undefined} model
 * @param {string} speedMode
 */
function isSpeedModeSupported(model, speedMode, modelRegistry) {
  if (speedMode === STANDARD_MODE) return true
  if (!isChatGptModel(model, modelRegistry)) return false
  if (speedMode === FAST_MODE) return isFastSupportedModel(model)
  if (speedMode === ULTRAFAST_MODE) return isUltrafastSupportedModel(model)
  return false
}

/**
 * @param {unknown} payload
 * @param {string} speedMode
 */
function addSpeedServiceTier(payload, speedMode) {
  const record = asRecord(payload)
  if (!record) return undefined
  if (speedMode === FAST_MODE) return { ...record, service_tier: "priority" }
  if (speedMode === ULTRAFAST_MODE)
    return { ...record, service_tier: "ultrafast" }
  return record
}

/** @param {unknown} payload */
function addFastServiceTier(payload) {
  return addSpeedServiceTier(payload, FAST_MODE)
}

/** @param {string | undefined} value */
function parseFastEnv(value) {
  if (value === "1") return true
  if (value === "0") return false
  return undefined
}

/** @param {string | undefined} value */
function parseSpeedEnv(value) {
  const speedMode = value?.toLowerCase()
  return SPEED_MODES.has(speedMode) ? speedMode : undefined
}

/** @param {number} count */
function formatTokens(count) {
  if (count < 1000) return count.toString()
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1000000) return `${Math.round(count / 1000)}k`
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`
  return `${Math.round(count / 1000000)}M`
}

/** @param {string} token */
function decodeJwtPayload(token) {
  const parts = token.split(".")
  if (parts.length < 2) return {}

  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
  } catch {
    return {}
  }
}

/** @param {string} token */
function getTokenMetadata(token) {
  const payload = decodeJwtPayload(token)
  const auth =
    payload && typeof payload === "object"
      ? payload[OPENAI_AUTH_CLAIM]
      : undefined
  const profile =
    payload && typeof payload === "object"
      ? payload[OPENAI_PROFILE_CLAIM]
      : undefined

  return {
    accountId:
      auth && typeof auth.chatgpt_account_id === "string"
        ? auth.chatgpt_account_id
        : undefined,
    planType:
      auth && typeof auth.chatgpt_plan_type === "string"
        ? auth.chatgpt_plan_type
        : undefined,
    email:
      profile && typeof profile.email === "string" ? profile.email : undefined,
  }
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | undefined}
 */
function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }

  return Object.fromEntries(Object.entries(value))
}

/** @param {unknown} value */
function normalizeWindow(value) {
  const record = asRecord(value)
  if (!record) return undefined

  const usedPercent =
    typeof record.used_percent === "number" ? record.used_percent : undefined
  const windowSeconds =
    typeof record.limit_window_seconds === "number"
      ? record.limit_window_seconds
      : undefined
  const resetAt =
    typeof record.reset_at === "number" ? record.reset_at : undefined

  if (
    usedPercent === undefined ||
    !Number.isFinite(usedPercent) ||
    windowSeconds === undefined ||
    !Number.isFinite(windowSeconds) ||
    (resetAt !== undefined && !Number.isFinite(resetAt * 1000))
  )
    return undefined
  return { usedPercent, windowSeconds, resetAt }
}

/** @param {unknown} data */
function parseUsageSnapshot(data) {
  const raw = asRecord(data)
  const rateLimit = asRecord(raw?.rate_limit)
  const windows = [
    normalizeWindow(rateLimit?.primary_window),
    normalizeWindow(rateLimit?.secondary_window),
  ].filter(Boolean)

  return {
    planType: typeof raw?.plan_type === "string" ? raw.plan_type : undefined,
    email: typeof raw?.email === "string" ? raw.email : undefined,
    fiveHour: windows.find(
      (window) => Math.abs(window.windowSeconds - FIVE_HOUR_SECONDS) <= 120,
    ),
    weekly: windows.find(
      (window) => Math.abs(window.windowSeconds - WEEK_SECONDS) <= 120,
    ),
    fetchedAt: Date.now(),
  }
}

/** @param {{ usedPercent: number } | undefined} window */
function formatUsedPercent(window) {
  if (!window) return "?%"
  return `${Math.round(Math.max(0, Math.min(100, window.usedPercent)))}%`
}

/** @param {{ usedPercent: number } | undefined} window */
function formatRemainingPercent(window) {
  if (!window) return "?%"
  return `${Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)))}%`
}

/** @param {number | undefined} resetAt */
function formatResetShort(resetAt) {
  if (!resetAt) return "?"

  const minutes = Math.max(0, Math.round((resetAt * 1000 - Date.now()) / 60000))
  const days = Math.floor(minutes / (60 * 24))
  const hours = Math.floor((minutes % (60 * 24)) / 60)

  if (days > 0) return `~${days}d`
  if (hours > 0) return `~${hours}h`
  return `~${minutes}m`
}

/** @param {number | undefined} resetAt */
function formatResetLong(resetAt) {
  if (!resetAt) return "unknown"

  const minutes = Math.max(0, Math.round((resetAt * 1000 - Date.now()) / 60000))
  const days = Math.floor(minutes / (60 * 24))
  const hours = Math.floor((minutes % (60 * 24)) / 60)
  const mins = minutes % 60

  if (days > 0) return `in ${days}d ${hours}h`
  if (hours > 0) return `in ${hours}h ${mins}m`
  return `in ${mins}m`
}

/* @param {{ usedPercent: number, windowSeconds: number, resetAt: number } | undefined} window
 * @returns {number} Pace in percentage points (positive = deficit, negative = reserve, 0 = on pace); NaN if not calculable
 */
function calculatePacePercentValue(window) {
  if (!window || !window.resetAt || !window.windowSeconds) return NaN

  const nowSec = Date.now() / 1000
  const resetAtSec = window.resetAt
  const windowSec = window.windowSeconds

  const windowStart = resetAtSec - windowSec
  if (nowSec < windowStart) return NaN

  const elapsedSec = Math.min(windowSec, nowSec - windowStart)
  const elapsedPercent = (elapsedSec / windowSec) * 100

  if (elapsedPercent < 0.1) return NaN

  return window.usedPercent - elapsedPercent
}

/* @param {{ usedPercent: number, windowSeconds: number, resetAt: number } | undefined} window */
function formatPacePercent(window) {
  const pace = calculatePacePercentValue(window)

  if (isNaN(pace)) {
    if (!window || !window.resetAt || !window.windowSeconds) return "?%"

    const nowSec = Date.now() / 1000
    const windowStart = window.resetAt - window.windowSeconds
    if (nowSec < windowStart) return "?% (not started)"

    return "?% (starting)"
  }

  if (Math.abs(pace) < 0.1) return "0% (on pace)"

  const roundedPace = Math.round(Math.abs(pace))
  return pace > 0 ? `${roundedPace}% (deficit)` : `${roundedPace}% (reserve)`
}

/* @param {{ usedPercent: number, windowSeconds: number, resetAt: number } | undefined} window */
function formatPacePercentShort(window) {
  const pace = calculatePacePercentValue(window)

  if (isNaN(pace)) return "?%"
  if (pace > 0) return `+${Math.round(pace)}%`
  if (pace < 0) return `${Math.round(pace)}%`
  return "=0%"
}

function normalizeFooterConfig(value) {
  const record = asRecord(value)
  const rawQuotaWindow = record?.quotaWindow
  const quotaWindow =
    typeof rawQuotaWindow === "string" &&
    QUOTA_WINDOW_OPTIONS.some((option) => option.value === rawQuotaWindow)
      ? rawQuotaWindow
      : DEFAULT_FOOTER_CONFIG.quotaWindow

  const rawDisplayMode = record?.displayMode
  const displayMode =
    typeof rawDisplayMode === "string" &&
    DISPLAY_MODE_OPTIONS.some((option) => option.value === rawDisplayMode)
      ? rawDisplayMode
      : DEFAULT_FOOTER_CONFIG.displayMode

  return { quotaWindow, displayMode }
}

function normalizeGlobalConfig(value) {
  const record = asRecord(value)
  const speedMode =
    parseSpeedEnv(
      typeof record?.speedMode === "string" ? record.speedMode : undefined,
    ) ?? (record?.fastMode === true ? FAST_MODE : STANDARD_MODE)
  return {
    ...normalizeFooterConfig(record),
    fastMode: speedMode !== STANDARD_MODE,
    speedMode,
  }
}

function getConfigPath(fileName = CONFIG_FILE_NAME) {
  const agentDir =
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")
  return join(agentDir, fileName)
}

async function readGlobalConfig(fileName) {
  try {
    return normalizeGlobalConfig(
      JSON.parse(await readFile(getConfigPath(fileName), "utf8")),
    )
  } catch {
    return undefined
  }
}

async function writeGlobalConfig() {
  const configPath = getConfigPath()
  const tempPath = `${configPath}.${process.pid}.tmp`
  const config = {
    ...footerConfig,
    fastMode: persistentSpeedMode !== STANDARD_MODE,
    speedMode: persistentSpeedMode,
  }
  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`)
  await rename(tempPath, configPath)
}

async function restoreGlobalConfig(ctx) {
  let config = await readGlobalConfig(CONFIG_FILE_NAME)
  if (!config) {
    config = await readGlobalConfig(LEGACY_CONFIG_FILE_NAME)
    if (config) {
      footerConfig = normalizeFooterConfig(config)
      persistentSpeedMode = config.speedMode
      await writeGlobalConfig()
      return
    }
  }

  if (config) {
    footerConfig = normalizeFooterConfig(config)
    persistentSpeedMode = config.speedMode
    return
  }

  footerConfig = restoreLegacySessionFooterConfig(ctx)
  persistentSpeedMode = STANDARD_MODE
}

function restoreLegacySessionFooterConfig(ctx) {
  let config = { ...DEFAULT_FOOTER_CONFIG }
  for (const entry of ctx.sessionManager.getBranch()) {
    if (
      entry.type === "custom" &&
      entry.customType === LEGACY_CONFIG_ENTRY_TYPE
    ) {
      config = normalizeFooterConfig(entry.data)
    }
  }
  return config
}

function describeFooterConfig() {
  const quotaWindow = QUOTA_WINDOW_OPTIONS.find(
    (option) => option.value === footerConfig.quotaWindow,
  )
  const displayMode = DISPLAY_MODE_OPTIONS.find(
    (option) => option.value === footerConfig.displayMode,
  )
  return `${quotaWindow?.label || "Weekly usage"}; ${displayMode?.label || "Used percent"}`
}

function inferProcessMode(
  argv = process.argv.slice(2),
  stdinIsTTY = process.stdin.isTTY,
  stdoutIsTTY = process.stdout.isTTY,
) {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--mode") {
      const mode = argv[index + 1]
      if (typeof mode === "string") return mode
    } else if (arg.startsWith("--mode=")) {
      return arg.slice("--mode=".length)
    }
  }

  if (argv.includes("--print") || argv.includes("-p")) return "print"
  return stdinIsTTY && stdoutIsTTY !== false ? "tui" : "print"
}

function isTuiContext(ctx, argv, stdinIsTTY, stdoutIsTTY) {
  const mode =
    typeof ctx.mode === "string"
      ? ctx.mode
      : inferProcessMode(argv, stdinIsTTY, stdoutIsTTY)

  return (
    (mode === "tui" || mode === "interactive") &&
    ctx.hasUI !== false &&
    typeof ctx.ui?.setFooter === "function"
  )
}

async function saveFooterConfig(nextConfig) {
  footerConfig = normalizeFooterConfig(nextConfig)
  requestRender()
  await writeGlobalConfig()
}

/** @param {PiAssistantUsage | undefined} usage */
function addUsage(total, usage) {
  total.input += usage?.input ?? 0
  total.output += usage?.output ?? 0
  total.cacheRead += usage?.cacheRead ?? 0
  total.cacheWrite += usage?.cacheWrite ?? 0
  total.cost += usage?.cost?.total ?? 0
}

function getUsageColor(window) {
  const used = Math.max(0, Math.min(100, window?.usedPercent ?? 0))
  if (used >= 90) return "error"
  if (used >= 80) return "warning"
  return "dim"
}

function formatFooterUsagePart(label, window, theme) {
  if (!window) return undefined

  let text
  if (label === "W" && footerConfig.displayMode.startsWith("pace")) {
    if (footerConfig.displayMode === "pace") {
      text = `WP ${formatPacePercent(window)}`
    } else if (footerConfig.displayMode === "paceCompact") {
      text = `WP ${formatPacePercentShort(window)}`
    } else if (footerConfig.displayMode === "paceResetCompact") {
      text = `WP ${formatPacePercentShort(window)} · ${formatResetShort(window.resetAt)}`
    }
  } else {
    if (footerConfig.displayMode === "remaining") {
      text = `${label} ${formatRemainingPercent(window)} left`
    } else if (footerConfig.displayMode === "remainingCompact") {
      text = `${label} ${formatRemainingPercent(window)} left · ${formatResetShort(window.resetAt)}`
    } else {
      const used = formatUsedPercent(window)
      text =
        footerConfig.displayMode === "compact"
          ? `${label} ${used} · ${formatResetShort(window.resetAt)}`
          : `${label} ${used}`
    }
  }

  return theme.fg(getUsageColor(window), text)
}

function formatFooterUsage(theme) {
  if (footerConfig.quotaWindow === "hidden") return undefined
  if (usageSnapshot?.httpStatus)
    return theme.fg("warning", `Usage: HTTP ${usageSnapshot.httpStatus}`)

  const parts = []
  if (
    footerConfig.quotaWindow === "fiveHour" ||
    footerConfig.quotaWindow === "both"
  ) {
    const part = formatFooterUsagePart("5h", usageSnapshot?.fiveHour, theme)
    if (part) parts.push(part)
  }
  if (
    footerConfig.quotaWindow === "weekly" ||
    footerConfig.quotaWindow === "both"
  ) {
    const part = formatFooterUsagePart("W", usageSnapshot?.weekly, theme)
    if (part) parts.push(part)
  }

  return parts.length > 0 ? parts.join(theme.fg("dim", " / ")) : undefined
}

/** @param {string} speedMode */
function renderFooter(
  pi,
  ctx,
  footerData,
  theme,
  width,
  speedMode = STANDARD_MODE,
) {
  const model = ctx.model

  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      addUsage(total, entry.message.usage)
    }
  }

  const contextUsage = ctx.getContextUsage()
  const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0
  const contextPercentValue = contextUsage?.percent ?? 0
  const contextPercent =
    contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?"

  let pwd = ctx.sessionManager.getCwd()
  const home = process.env.HOME || process.env.USERPROFILE
  if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`

  const branch = footerData.getGitBranch()
  if (branch) pwd = `${pwd} (${branch})`

  const sessionName = ctx.sessionManager.getSessionName()
  if (sessionName) pwd = `${pwd} • ${sessionName}`

  const statsParts = []
  if (total.input) statsParts.push(`↑${formatTokens(total.input)}`)
  if (total.output) statsParts.push(`↓${formatTokens(total.output)}`)
  if (total.cacheRead) statsParts.push(`R${formatTokens(total.cacheRead)}`)
  if (total.cacheWrite) statsParts.push(`W${formatTokens(total.cacheWrite)}`)

  const usingSubscription = model
    ? ctx.modelRegistry.isUsingOAuth(model)
    : false
  if (total.cost || usingSubscription)
    statsParts.push(
      `$${total.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`,
    )

  const contextDisplay =
    contextPercent === "?"
      ? `?/${formatTokens(contextWindow)}`
      : `${contextPercent}%/${formatTokens(contextWindow)}`
  const contextColored =
    contextPercentValue > 90
      ? theme.fg("error", contextDisplay)
      : contextPercentValue > 70
        ? theme.fg("warning", contextDisplay)
        : contextDisplay
  statsParts.push(contextColored)

  let statsLeft = statsParts.join(" ")
  let statsLeftWidth = visibleWidth(statsLeft)
  if (statsLeftWidth > width) {
    statsLeft = truncateToWidth(statsLeft, width, "...")
    statsLeftWidth = visibleWidth(statsLeft)
  }

  const modelName = terminalText(model?.id || "no-model")
  let rightSideWithoutProvider = modelName
  if (model?.reasoning) {
    const thinkingLevel = pi.getThinkingLevel ? pi.getThinkingLevel() : "off"
    rightSideWithoutProvider =
      thinkingLevel === "off"
        ? `${modelName} • thinking off`
        : `${modelName} • ${thinkingLevel}`
  }

  if (
    speedMode !== STANDARD_MODE &&
    isSpeedModeSupported(model, speedMode, ctx.modelRegistry)
  ) {
    rightSideWithoutProvider += ` • ${SPEED_MODE_LABELS[speedMode]}`
  }

  if (isChatGptModel(model, ctx.modelRegistry)) {
    const footerUsage = formatFooterUsage(theme)
    if (footerUsage) {
      rightSideWithoutProvider += ` • ${footerUsage}`
    }
  }

  let rightSide = rightSideWithoutProvider
  if (footerData.getAvailableProviderCount() > 1 && model) {
    rightSide = `(${terminalText(model.provider)}) ${rightSideWithoutProvider}`
    if (statsLeftWidth + 2 + visibleWidth(rightSide) > width)
      rightSide = rightSideWithoutProvider
  }

  const rightSideWidth = visibleWidth(rightSide)
  const minPadding = 2
  let statsLine
  if (statsLeftWidth + minPadding + rightSideWidth <= width) {
    statsLine =
      statsLeft +
      " ".repeat(width - statsLeftWidth - rightSideWidth) +
      rightSide
  } else {
    const availableForRight = width - statsLeftWidth - minPadding
    if (availableForRight > 0) {
      const truncatedRight = truncateToWidth(rightSide, availableForRight, "")
      statsLine =
        statsLeft +
        " ".repeat(
          Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)),
        ) +
        truncatedRight
    } else {
      statsLine = statsLeft
    }
  }

  const dimPwd = theme.fg("dim", terminalText(pwd))
  const dimEllipsis = theme.fg("dim", "...")
  let pwdLine = truncateToWidth(dimPwd, width, dimEllipsis)
  const extensionStatuses =
    typeof footerData.getExtensionStatuses === "function"
      ? footerData.getExtensionStatuses()
      : undefined
  const statusGroup = Array.from(extensionStatuses?.entries() || [])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) =>
      typeof text === "string"
        ? text
            .replace(/[\r\n\t]/g, " ")
            .replace(/ +/g, " ")
            .trim()
        : "",
    )
    .filter((text) => visibleWidth(text) > 0)
    .join(" ")

  if (statusGroup && width > 2) {
    const minPwdWidth = Math.min(
      visibleWidth(dimPwd),
      Math.max(1, Math.floor((width - 2) / 2)),
    )
    const maxStatusWidth = width - minPwdWidth - 2
    const visibleStatusGroup = truncateToWidth(
      statusGroup,
      maxStatusWidth,
      dimEllipsis,
    )
    const statusWidth = visibleWidth(visibleStatusGroup)
    if (statusWidth > 0) {
      const availableForPwd = width - statusWidth - 2
      pwdLine = truncateToWidth(dimPwd, availableForPwd, dimEllipsis)
      pwdLine +=
        " ".repeat(Math.max(2, width - visibleWidth(pwdLine) - statusWidth)) +
        visibleStatusGroup
    }
  }

  const remainder = statsLine.slice(statsLeft.length)
  return [pwdLine, theme.fg("dim", statsLeft) + theme.fg("dim", remainder)]
}

/** @param {PiExtensionContext} ctx */
function installFooter(pi, ctx, getSpeedMode) {
  ctx.ui.setFooter((tui, theme, footerData) => {
    requestRender = () => tui.requestRender()
    const unsub = footerData.onBranchChange(() => tui.requestRender())
    return {
      dispose() {
        unsub?.()
      },
      invalidate() {},
      render(width) {
        return renderFooter(pi, ctx, footerData, theme, width, getSpeedMode())
      },
    }
  })
}

/** @param {PiExtensionContext} ctx */
async function updateUsage(ctx) {
  const model = ctx.model
  if (!isChatGptModel(model, ctx.modelRegistry)) {
    usageSnapshot = undefined
    requestRender()
    return undefined
  }

  if (!CHATGPT_BASE_URL) {
    usageSnapshot = undefined
    requestRender()
    return undefined
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
  if (!auth.ok || !auth.apiKey) {
    usageSnapshot = undefined
    requestRender()
    return undefined
  }

  const tokenMetadata = getTokenMetadata(auth.apiKey)
  const headers = {
    Authorization: `Bearer ${auth.apiKey}`,
    Accept: "application/json",
    "User-Agent": "pi-chatgpt",
    ...(tokenMetadata.accountId
      ? { "chatgpt-account-id": tokenMetadata.accountId }
      : {}),
  }

  try {
    const response = await fetch(`${CHATGPT_BASE_URL}/wham/usage`, {
      headers,
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) {
      // Keep only the status; server error bodies may contain private data.
      usageSnapshot = { httpStatus: response.status }
      requestRender()
      return undefined
    }

    usageSnapshot = parseUsageSnapshot(await response.json())
    if (!usageSnapshot.email && tokenMetadata.email)
      usageSnapshot.email = tokenMetadata.email
    if (!usageSnapshot.planType && tokenMetadata.planType)
      usageSnapshot.planType = tokenMetadata.planType
    requestRender()
    return usageSnapshot
  } catch {
    usageSnapshot = undefined
    requestRender()
    return undefined
  }
}

function buildUsageDetails(snapshot, provider) {
  const lines = []
  lines.push(`provider: ${provider}`)
  lines.push(`plan: ${snapshot?.planType || "unknown"}`)
  if (snapshot?.email) lines.push(`email: ${snapshot.email}`)
  lines.push(
    `5-hour: ${formatUsedPercent(snapshot?.fiveHour)} used, ${formatRemainingPercent(snapshot?.fiveHour)} left, resets ${formatResetLong(snapshot?.fiveHour?.resetAt)}`,
  )
  lines.push(
    `weekly: ${formatUsedPercent(snapshot?.weekly)} used, ${formatRemainingPercent(snapshot?.weekly)} left, resets ${formatResetLong(snapshot?.weekly?.resetAt)}`,
  )
  lines.push(`pace: ${formatPacePercent(snapshot?.weekly)}`)
  if (snapshot?.fetchedAt)
    lines.push(`fetched: ${new Date(snapshot.fetchedAt).toLocaleString()}`)
  lines.push(`footer: ${describeFooterConfig()}`)
  lines.push(
    `endpoint: ${
      CHATGPT_BASE_URL
        ? `${CHATGPT_BASE_URL}/wham/usage`
        : `disabled (${CHATGPT_BASE_URL_RESULT.reason})`
    }`,
  )
  return lines.map(terminalText)
}

async function selectFooterConfigOptionFallback(
  ctx,
  title,
  options,
  currentValue,
) {
  const labels = options.map((option) =>
    option.value === currentValue ? `${option.label} (current)` : option.label,
  )
  const selectedLabel = await ctx.ui.select(title, labels)
  if (!selectedLabel) return undefined

  const selectedIndex = labels.indexOf(selectedLabel)
  return selectedIndex >= 0 ? options[selectedIndex] : undefined
}

async function selectFooterConfigOption(
  ctx,
  title,
  options,
  currentValue,
  preview,
) {
  const initialIndex = Math.max(
    0,
    options.findIndex((option) => option.value === currentValue),
  )
  const originalConfig = { ...footerConfig }

  const selected =
    typeof ctx.ui.custom === "function"
      ? await ctx.ui.custom((tui, theme, _keybindings, done) => {
          let selectedIndex = initialIndex

          function applyPreview() {
            preview(options[selectedIndex].value)
            requestRender()
          }

          applyPreview()

          return {
            invalidate() {},
            handleInput(data) {
              if (matchesKey(data, Key.up)) {
                selectedIndex = Math.max(0, selectedIndex - 1)
                applyPreview()
                tui.requestRender()
                return
              }
              if (matchesKey(data, Key.down)) {
                selectedIndex = Math.min(options.length - 1, selectedIndex + 1)
                applyPreview()
                tui.requestRender()
                return
              }
              if (matchesKey(data, Key.enter)) {
                done(options[selectedIndex])
                return
              }
              if (
                matchesKey(data, Key.escape) ||
                matchesKey(data, Key.ctrl("c"))
              ) {
                done(CUSTOM_CONFIG_CANCELLED)
              }
            },
            render(width) {
              const lines = [
                theme.fg("accent", theme.bold(title)),
                theme.fg(
                  "dim",
                  "↑↓ preview in footer • enter save • esc cancel",
                ),
                "",
              ]

              for (let index = 0; index < options.length; index++) {
                const option = options[index]
                const isSelected = index === selectedIndex
                const isCurrent = option.value === currentValue
                const prefix = isSelected ? "› " : "  "
                const suffix = isCurrent ? "  current" : ""
                const text = `${prefix}${option.label}${suffix}`
                lines.push(
                  truncateToWidth(
                    isSelected ? theme.fg("accent", text) : text,
                    width,
                    "…",
                  ),
                )
              }

              return lines.map((line) => truncateToWidth(line, width, "…"))
            },
          }
        })
      : undefined

  if (selected === CUSTOM_CONFIG_CANCELLED) {
    footerConfig = originalConfig
    requestRender()
    return undefined
  }

  if (selected) return selected

  footerConfig = originalConfig
  requestRender()
  return selectFooterConfigOptionFallback(ctx, title, options, currentValue)
}

async function configureQuotaWindow(ctx) {
  const selected = await selectFooterConfigOption(
    ctx,
    "Display which ChatGPT limit in footer?",
    QUOTA_WINDOW_OPTIONS,
    footerConfig.quotaWindow,
    (quotaWindow) => {
      footerConfig = normalizeFooterConfig({ ...footerConfig, quotaWindow })
    },
  )
  if (!selected) return

  await saveFooterConfig({ ...footerConfig, quotaWindow: selected.value })
  ctx.ui.notify(
    selected.value === "hidden"
      ? "ChatGPT footer display: Hide usage from footer (usage hidden)."
      : `ChatGPT footer display: ${selected.label}`,
    "info",
  )
}

async function configureDisplayMode(ctx) {
  const selected = await selectFooterConfigOption(
    ctx,
    "How should the footer value be shown?",
    DISPLAY_MODE_OPTIONS,
    footerConfig.displayMode,
    (displayMode) => {
      footerConfig = normalizeFooterConfig({ ...footerConfig, displayMode })
    },
  )
  if (!selected) return

  await saveFooterConfig({ ...footerConfig, displayMode: selected.value })
  ctx.ui.notify(`ChatGPT footer mode: ${selected.label}`, "info")
}

async function resetFooterConfig(ctx) {
  const confirmed = await ctx.ui.confirm(
    "Reset ChatGPT footer settings?",
    "This restores the default footer display: weekly usage, used percent.",
  )
  if (!confirmed) return

  await saveFooterConfig(DEFAULT_FOOTER_CONFIG)
  ctx.ui.notify("ChatGPT footer settings reset to defaults.", "info")
}

export const __test__ = {
  calculatePacePercentValue,
  formatPacePercent,
  formatPacePercentShort,
  formatRemainingPercent,
  formatResetShort,
  formatUsedPercent,
  addFastServiceTier,
  addSpeedServiceTier,
  getTokenMetadata,
  isFastSupportedModel,
  isSpeedModeSupported,
  isUltrafastSupportedModel,
  isChatGptProvider,
  normalizeFooterConfig,
  normalizeGlobalConfig,
  parseFastEnv,
  parseSpeedEnv,
  inferProcessMode,
  isTuiContext,
  parseUsageSnapshot,
  renderFooter,
  resolveChatGptBaseUrl,
}

export default function (pi) {
  /** @type {Promise<unknown>} */
  let inFlight = Promise.resolve()
  let speedMode = STANDARD_MODE
  const inheritedFastEnv = process.env[FAST_ENV]
  const inheritedSpeedEnv = process.env[SPEED_ENV]
  let ownedFastEnvValue
  let ownedSpeedEnvValue

  function queueUpdate(ctx) {
    inFlight = inFlight.catch(() => undefined).then(() => updateUsage(ctx))
    return inFlight
  }

  function queueUpdateInBackground(ctx) {
    void queueUpdate(ctx).catch(() => undefined)
  }

  function queueAutomaticUpdateInBackground(ctx) {
    if (!isTuiContext(ctx)) return
    queueUpdateInBackground(ctx)
  }

  function updateSpeedEnvironment(ctx, model = ctx.model) {
    const fastValue =
      speedMode !== STANDARD_MODE &&
      isSpeedModeSupported(model, speedMode, ctx.modelRegistry)
        ? "1"
        : "0"
    process.env[FAST_ENV] = fastValue
    process.env[SPEED_ENV] = speedMode
    ownedFastEnvValue = fastValue
    ownedSpeedEnvValue = speedMode
    requestRender()
  }

  function restoreSpeedEnvironment() {
    if (
      ownedFastEnvValue !== undefined &&
      process.env[FAST_ENV] === ownedFastEnvValue
    ) {
      if (inheritedFastEnv === undefined) delete process.env[FAST_ENV]
      else process.env[FAST_ENV] = inheritedFastEnv
      ownedFastEnvValue = undefined
    }

    if (
      ownedSpeedEnvValue !== undefined &&
      process.env[SPEED_ENV] === ownedSpeedEnvValue
    ) {
      if (inheritedSpeedEnv === undefined) delete process.env[SPEED_ENV]
      else process.env[SPEED_ENV] = inheritedSpeedEnv
      ownedSpeedEnvValue = undefined
    }
  }

  async function handleChatGptCommand(_args, ctx) {
    const action = await ctx.ui.select("ChatGPT Codex usage limits", [
      "Show current usage details",
      `Configure footer limit (${describeFooterConfig()})`,
      "Configure footer display mode",
      "Reset footer settings to defaults",
    ])

    if (action === "Configure footer display mode") {
      await configureDisplayMode(ctx)
      return
    }

    if (action === "Reset footer settings to defaults") {
      await resetFooterConfig(ctx)
      return
    }

    if (action?.startsWith("Configure footer limit")) {
      await configureQuotaWindow(ctx)
      return
    }

    if (!action) return

    if (!isChatGptModel(ctx.model, ctx.modelRegistry)) {
      ctx.ui.notify(
        "ChatGPT limits require an openai model authenticated with ChatGPT OAuth via /login.",
        "info",
      )
      return
    }

    const snapshot = await queueUpdate(ctx)
    if (!snapshot) {
      const status = usageSnapshot?.httpStatus
      ctx.ui.notify(
        `Could not load ChatGPT usage limits${status ? ` (HTTP ${status})` : ""}.`,
        "warning",
      )
      return
    }

    await ctx.ui.select(
      "ChatGPT Codex usage limits",
      buildUsageDetails(snapshot, ctx.model?.provider),
    )
  }

  pi.on("session_start", async (_event, ctx) => {
    await restoreGlobalConfig(ctx)
    const inheritedSpeedMode = parseSpeedEnv(inheritedSpeedEnv)
    const inheritedFastEnabled = parseFastEnv(inheritedFastEnv)
    speedMode =
      inheritedSpeedMode ??
      (inheritedFastEnabled === undefined
        ? persistentSpeedMode
        : inheritedFastEnabled
          ? FAST_MODE
          : STANDARD_MODE)
    updateSpeedEnvironment(ctx)
    if (!isTuiContext(ctx)) return

    installFooter(pi, ctx, () => speedMode)
    queueUpdateInBackground(ctx)
  })

  pi.on("model_select", (event, ctx) => {
    updateSpeedEnvironment(ctx, event.model || ctx.model)
    queueAutomaticUpdateInBackground(ctx)
  })
  pi.on("agent_end", (_event, ctx) => queueAutomaticUpdateInBackground(ctx))

  pi.on("before_provider_request", (event, ctx) => {
    if (
      speedMode === STANDARD_MODE ||
      !isSpeedModeSupported(ctx.model, speedMode, ctx.modelRegistry)
    )
      return undefined
    return addSpeedServiceTier(event.payload, speedMode)
  })

  pi.on("session_shutdown", async () => {
    requestRender = () => {}
    restoreSpeedEnvironment()
  })

  pi.registerCommand("fast", {
    description:
      "Set ChatGPT Codex speed: temporary|persistent [standard|fast|ultrafast]",
    getArgumentCompletions: (prefix) =>
      [
        "temporary",
        "temporary standard",
        "temporary fast",
        "temporary ultrafast",
        "persistent",
        "persistent standard",
        "persistent fast",
        "persistent ultrafast",
        "status",
        "off",
      ]
        .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const tokens = String(args)
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
      if (tokens.length === 1 && tokens[0] === "status") {
        const label = SPEED_MODE_LABELS[speedMode]
        const modelName = ctx.model
          ? terminalText(`${ctx.model.provider}/${ctx.model.id}`)
          : "the current model"
        const state =
          speedMode === STANDARD_MODE
            ? "active"
            : !isChatGptModel(ctx.model, ctx.modelRegistry)
              ? "selected; requires ChatGPT OAuth via /login on openai"
              : isSpeedModeSupported(ctx.model, speedMode, ctx.modelRegistry)
                ? "active"
                : `selected; unsupported by ${modelName}`
        ctx.ui.notify(
          `ChatGPT speed: ${label} (${state}).`,
          state === "active" ? "info" : "warning",
        )
        return
      }

      const isOff = tokens.length === 1 && tokens[0] === "off"
      const scope = isOff ? "persistent" : tokens[0]
      const selectedSpeedMode = isOff
        ? STANDARD_MODE
        : tokens.length === 1
          ? FAST_MODE
          : tokens[1]
      if (
        (scope !== "temporary" && scope !== "persistent") ||
        !SPEED_MODES.has(selectedSpeedMode) ||
        tokens.length > 2
      ) {
        ctx.ui.notify(
          "Usage: /fast temporary|persistent [standard|fast|ultrafast] | off | status",
          "warning",
        )
        return
      }

      if (scope === "persistent") {
        const previousPersistentSpeedMode = persistentSpeedMode
        persistentSpeedMode = selectedSpeedMode
        try {
          await writeGlobalConfig()
        } catch (error) {
          persistentSpeedMode = previousPersistentSpeedMode
          throw error
        }
      }
      speedMode = selectedSpeedMode
      updateSpeedEnvironment(ctx)

      let message = isOff
        ? "Fast mode disabled."
        : speedMode === FAST_MODE
          ? `Fast mode enabled ${scope === "temporary" ? "temporarily" : "persistently"}.`
          : `${SPEED_MODE_LABELS[speedMode]} mode selected ${scope === "temporary" ? "temporarily" : "persistently"}.`
      if (
        speedMode !== STANDARD_MODE &&
        !isSpeedModeSupported(ctx.model, speedMode, ctx.modelRegistry)
      ) {
        if (!isChatGptModel(ctx.model, ctx.modelRegistry)) {
          message += " Not active: requires ChatGPT OAuth via /login on openai."
        } else {
          const modelName = ctx.model
            ? terminalText(`${ctx.model.provider}/${ctx.model.id}`)
            : "the current model"
          message += ` Not active: ${modelName} does not support ${SPEED_MODE_LABELS[speedMode]} mode.`
          if (speedMode === ULTRAFAST_MODE)
            message +=
              " Ultrafast currently supports gpt-6-astra and gpt-6.1-sol only."
        }
      }
      ctx.ui.notify(
        message,
        speedMode !== STANDARD_MODE &&
          !isSpeedModeSupported(ctx.model, speedMode, ctx.modelRegistry)
          ? "warning"
          : "info",
      )
    },
  })

  pi.registerCommand("chatgpt", {
    description: "Show and configure ChatGPT Codex usage",
    handler: handleChatGptCommand,
  })
  pi.registerCommand("chatgpt-limit", {
    description: "Legacy alias for /chatgpt",
    handler: handleChatGptCommand,
  })
}
