/**
 * Defensive-not-documented request gating for Deezer calls — ADR-0001 Q2 /
 * plan §G-10.
 *
 * ADR-0001 found no official Deezer page stating a numeric rate limit; the
 * widely-cited "50 req/5s" is a third-party figure, not a contractual one. So
 * this does **not** implement a request-per-window budget. It does two things
 * instead:
 *
 *   1. A modest **concurrency cap** — politeness, not a documented ceiling.
 *   2. **Reactive backoff on 429** — exponential, honouring `Retry-After` when
 *      Deezer sends one, because that response *is* authoritative regardless
 *      of what any number we might hardcode would have said.
 *
 * This class is instantiated fresh per `DeezerProvider` (see `deezer.ts`), not
 * held at module scope. Workers isolates are not one process — a module-level
 * counter would evaporate between isolates and give a false sense of shared
 * throttling. That's fine here: a concurrency cap only needs to hold within
 * the lifetime of the calls it's wrapping, unlike the *documented* rate limits
 * in plan 1.18 (search 30/min, session create 10/min, finalize 20/min), which
 * need to hold across isolates and therefore live in D1, not here.
 */

export interface ThrottleOptions {
	/** Simultaneous in-flight requests. */
	maxConcurrent?: number;
	/** Retries on 429/5xx before giving up. */
	maxRetries?: number;
	/** Base backoff, doubled per attempt (plus jitter), when Deezer sends no `Retry-After`. */
	baseBackoffMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Throttle {
	private readonly maxConcurrent: number;
	private readonly maxRetries: number;
	private readonly baseBackoffMs: number;
	private readonly sleep: (ms: number) => Promise<void>;
	private inFlight = 0;
	private readonly waiters: Array<() => void> = [];

	constructor(opts: ThrottleOptions = {}) {
		this.maxConcurrent = opts.maxConcurrent ?? 6;
		this.maxRetries = opts.maxRetries ?? 4;
		this.baseBackoffMs = opts.baseBackoffMs ?? 400;
		this.sleep = opts.sleep ?? defaultSleep;
	}

	private async acquire(): Promise<void> {
		if (this.inFlight < this.maxConcurrent) {
			this.inFlight++;
			return;
		}
		await new Promise<void>((resolve) => this.waiters.push(resolve));
		this.inFlight++;
	}

	private release(): void {
		this.inFlight--;
		const next = this.waiters.shift();
		if (next) next();
	}

	/**
	 * Runs `fn` under the concurrency cap. `fn` should return the raw
	 * `Response` (or throw) — this wrapper inspects `.status` to decide whether
	 * to retry, so it must be given the response before the body is consumed
	 * by anything that can't be re-read.
	 */
	async run(fn: () => Promise<Response>): Promise<Response> {
		await this.acquire();
		try {
			let lastResponse: Response | undefined;
			for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
				const res = await fn();
				if (res.status !== 429 && res.status < 500) return res;

				lastResponse = res;
				if (attempt === this.maxRetries) return res;

				const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
				const backoff = retryAfterMs ?? this.baseBackoffMs * 2 ** attempt + Math.random() * 100;
				await this.sleep(backoff);
			}
			// Unreachable in practice (the loop always returns), but keeps the
			// compiler honest about lastResponse being defined on every path.
			return lastResponse as Response;
		} finally {
			this.release();
		}
	}
}

/** `Retry-After` is either delta-seconds or an HTTP-date; only delta-seconds is worth honouring here. */
function parseRetryAfter(headerValue: string | null): number | null {
	if (!headerValue) return null;
	const seconds = Number(headerValue);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	return null;
}
