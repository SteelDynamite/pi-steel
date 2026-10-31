import type { TokenSpeedMeasurement } from "./types.ts";

// Self-contained adaptation of pi-token-speed 0.1.0 src/token-speed.ts (MIT).
// Keep measurement semantics in parity; test/token-speed.test.mjs contains reference fixtures.
const WINDOW_MS = 5_000;
const WARMUP_MS = 500;
const CHARS_PER_TOKEN = 4;

interface Call {
	firstOutputAt?: number;
	lastOutputAt?: number;
	fallbackChars: number;
	samples: Array<{ at: number; chars: number }>;
}

/** One child launch attempt; callers supply monotonic receipt times, never message timestamps. */
export class TokenSpeedTracker {
	private current?: Call;
	private tokens = 0;
	private durationMs = 0;

	beginCall(): void {
		this.current = { fallbackChars: 0, samples: [] };
	}

	addDelta(delta: string, at: number): TokenSpeedMeasurement | undefined {
		if (!Number.isFinite(at)) return undefined;
		if (delta.length === 0) return this.liveMeasurement(at);
		if (!this.current) this.beginCall();
		const call = this.current!;
		if (call.firstOutputAt === undefined) {
			call.firstOutputAt = at;
			return undefined;
		}
		call.lastOutputAt = at;
		call.fallbackChars += delta.length;
		call.samples.push({ at, chars: delta.length });
		return this.liveMeasurement(at);
	}

	endCall(providerOutputTokens: number | undefined): TokenSpeedMeasurement | undefined {
		const call = this.current;
		this.current = undefined;
		if (call?.firstOutputAt === undefined || call.lastOutputAt === undefined) return this.aggregateMeasurement();
		const durationMs = call.lastOutputAt - call.firstOutputAt;
		const tokens = Number.isFinite(providerOutputTokens) && providerOutputTokens! > 0
			? Math.max(providerOutputTokens! - 1, 0)
			: call.fallbackChars / CHARS_PER_TOKEN;
		if (durationMs > 0 && tokens > 0 && Number.isFinite(tokens + this.tokens) && Number.isFinite(durationMs + this.durationMs)) {
			this.tokens += tokens;
			this.durationMs += durationMs;
		}
		return this.aggregateMeasurement();
	}

	private liveMeasurement(at: number): TokenSpeedMeasurement | undefined {
		const call = this.current;
		if (call?.firstOutputAt === undefined) return undefined;
		const elapsedMs = at - call.firstOutputAt;
		if (elapsedMs < WARMUP_MS) return undefined;
		call.samples = call.samples.filter((sample) => sample.at >= at - WINDOW_MS);
		const tokens = call.samples.reduce((total, sample) => total + sample.chars, 0) / CHARS_PER_TOKEN;
		const durationMs = Math.min(elapsedMs, WINDOW_MS);
		return tokens > 0 && Number.isFinite(tokens) && durationMs > 0 ? { mode: "live", tokens, durationMs } : undefined;
	}

	aggregateMeasurement(): TokenSpeedMeasurement | undefined {
		return this.tokens > 0 && this.durationMs > 0 ? { mode: "aggregate", tokens: this.tokens, durationMs: this.durationMs } : undefined;
	}
}

export function streamDelta(event: any): string | undefined {
	return ["text_delta", "thinking_delta", "toolcall_delta"].includes(event?.type) && typeof event.delta === "string" ? event.delta : undefined;
}

/** Validate persisted/untrusted nested details before displaying a rate. */
export function formatTokenSpeed(measurement: TokenSpeedMeasurement | undefined): string {
	if (!measurement || !["live", "aggregate"].includes(measurement.mode) || !Number.isFinite(measurement.tokens) || measurement.tokens <= 0 || !Number.isFinite(measurement.durationMs) || measurement.durationMs <= 0) return "";
	const rate = measurement.tokens / (measurement.durationMs / 1_000);
	return Number.isFinite(rate) ? ` · ${measurement.mode === "live" ? "~" : ""}${rate.toFixed(1)} tok/s` : "";
}
