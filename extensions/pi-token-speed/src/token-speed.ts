export const WINDOW_MS = 5_000;
export const WARMUP_MS = 500;
const CHARS_PER_TOKEN = 4;

interface Sample {
	at: number;
	chars: number;
}

interface Call {
	firstOutputAt?: number;
	lastOutputAt?: number;
	fallbackChars: number;
	samples: Sample[];
}

interface Interval {
	tokens: number;
	durationMs: number;
}

/** Tracks one agent run. Times are injected by callers for deterministic tests. */
export class TokenSpeedTracker {
	private current?: Call;
	private intervals: Interval[] = [];

	startRun(): void {
		this.current = undefined;
		this.intervals = [];
	}

	beginCall(): void {
		this.current = { fallbackChars: 0, samples: [] };
	}

	addDelta(delta: string, at: number): number | undefined {
		if (delta.length === 0) return this.liveRate(at);
		if (!this.current) this.beginCall();

		const call = this.current!;
		if (call.firstOutputAt === undefined) {
			call.firstOutputAt = at;
			return undefined;
		}

		call.lastOutputAt = at;
		call.fallbackChars += delta.length;
		call.samples.push({ at, chars: delta.length });
		return this.liveRate(at);
	}

	endCall(providerOutputTokens: number | undefined): number | undefined {
		const call = this.current;
		this.current = undefined;
		if (call?.firstOutputAt === undefined || call.lastOutputAt === undefined) return this.aggregateRate();

		const durationMs = call.lastOutputAt - call.firstOutputAt;
		const tokens = Number.isFinite(providerOutputTokens) && providerOutputTokens! > 0
			? Math.max(providerOutputTokens! - 1, 0)
			: call.fallbackChars / CHARS_PER_TOKEN;
		if (durationMs > 0 && tokens > 0) this.intervals.push({ tokens, durationMs });
		return this.aggregateRate();
	}

	liveRate(at: number): number | undefined {
		const call = this.current;
		if (call?.firstOutputAt === undefined) return undefined;

		const elapsedMs = at - call.firstOutputAt;
		if (elapsedMs < WARMUP_MS) return undefined;

		const earliest = at - WINDOW_MS;
		call.samples = call.samples.filter((sample) => sample.at >= earliest);
		const chars = call.samples.reduce((total, sample) => total + sample.chars, 0);
		const durationMs = Math.min(elapsedMs, WINDOW_MS);
		return chars > 0 && durationMs > 0 ? chars / CHARS_PER_TOKEN / (durationMs / 1_000) : undefined;
	}

	aggregateRate(): number | undefined {
		const tokens = this.intervals.reduce((total, interval) => total + interval.tokens, 0);
		const durationMs = this.intervals.reduce((total, interval) => total + interval.durationMs, 0);
		return tokens > 0 && durationMs > 0 ? tokens / (durationMs / 1_000) : undefined;
	}
}

export function streamDelta(event: { type: string; delta?: string }): string | undefined {
	return event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta"
		? event.delta ?? ""
		: undefined;
}

export function formatSpeed(speed: number | undefined): string | undefined {
	return speed !== undefined && Number.isFinite(speed) && speed >= 0 ? `${speed.toFixed(1)} tok/s` : undefined;
}
