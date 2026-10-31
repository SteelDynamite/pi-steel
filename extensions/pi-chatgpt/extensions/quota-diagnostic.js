/**
 * Optional, passive, one-request diagnostic. Not loaded by index.js.
 * Candidate schema: openai/codex codex-rs/codex-api/src/rate_limits.rs.
 * Availability on public-API OAuth responses remains unverified.
 */

/** @param {unknown} value @returns {Record<string, unknown> | undefined} */
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : undefined
}

/** @param {unknown} value @param {boolean} integer */
function quotaNumber(value, integer) {
  // Never retain malformed remote text, even under an allowlisted field name.
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER &&
    (!integer || Number.isSafeInteger(value))
    ? value
    : "invalid"
}

function eligible(ctx) {
  return (
    ctx.model?.provider === "openai" &&
    ctx.modelRegistry.isUsingOAuth(ctx.model)
  )
}

export default function (pi) {
  let phase = "off"
  let report

  pi.registerCommand("chatgpt-quota-diagnostic", {
    description: "Passive quota metadata diagnostic: arm | show | off",
    handler: async (args, ctx) => {
      switch (args.trim()) {
        case "arm":
          if (!ctx.isIdle() || !eligible(ctx)) {
            ctx.ui.notify(
              "Wait until idle and select an openai model using ChatGPT OAuth via /login.",
              "warning",
            )
            return
          }
          report = {
            responseHooks: 0,
            streamHooks: 0,
            quotaEvents: 0,
            headers: {},
            streamQuota: {},
          }
          phase = "armed"
          ctx.ui.notify(
            "Quota diagnostic armed for the next request in your normal work. No request sent. Use show afterward; off clears it.",
            "info",
          )
          return
        case "show":
          ctx.ui.notify(
            `Quota diagnostic: ${phase}\n${JSON.stringify(report ?? {}, null, 2)}`,
            "info",
          )
          return
        case "off":
          phase = "off"
          report = undefined
          ctx.ui.notify("Quota diagnostic off; memory cleared.", "info")
          return
        default:
          ctx.ui.notify(
            "Usage: /chatgpt-quota-diagnostic arm | show | off",
            "info",
          )
      }
    },
  })

  pi.on("before_provider_request", (_event, ctx) => {
    // Ignore the payload. A second request (tool continuation/retry) ends capture.
    if (phase === "capturing") phase = "done"
    if (phase === "armed") phase = eligible(ctx) ? "capturing" : "done"
  })

  pi.on("after_provider_response", (event, ctx) => {
    if (phase !== "capturing" || !eligible(ctx)) return
    report.responseHooks++
    // Retries may emit several responses for one payload; retain only the latest.
    report.headers = {}
    const headers = record(event.headers)
    // Pi normalizes response header keys to lowercase. Do not enumerate them.
    for (const window of ["primary", "secondary"]) {
      for (const field of ["used-percent", "window-minutes", "reset-at"]) {
        const key = `x-codex-${window}-${field}`
        const raw = headers?.[key]
        if (raw === undefined) continue
        const value =
          typeof raw === "string" && /^\d+(\.\d+)?$/.test(raw)
            ? Number(raw)
            : undefined
        report.headers[key] = quotaNumber(value, field !== "used-percent")
      }
    }
  })

  pi.on("provider_stream_event", (event, ctx) => {
    if (
      phase !== "capturing" ||
      !eligible(ctx) ||
      event.provider !== ctx.model.provider ||
      event.model !== ctx.model.id
    )
      return
    report.streamHooks++
    const data = record(event.data)
    if (data?.type !== "codex.rate_limits") return
    report.quotaEvents++
    const limits = record(data.rate_limits)
    // Retain only the latest quota event, never an unbounded event log.
    report.streamQuota = {}
    for (const window of ["primary", "secondary"]) {
      const quota = record(limits?.[window])
      for (const field of ["used_percent", "window_minutes", "reset_at"]) {
        const value = quota?.[field]
        if (value === undefined) continue
        report.streamQuota[`${window}.${field}`] = quotaNumber(
          value,
          field !== "used_percent",
        )
      }
    }
  })

  pi.on("agent_end", () => {
    if (phase === "capturing") phase = "done"
  })
  for (const event of ["model_select", "session_shutdown"]) {
    pi.on(event, () => {
      phase = "off"
      report = undefined
    })
  }
}
