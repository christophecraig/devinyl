/**
 * Preview-URL availability + duration measurement — §5.4, MUS-5.
 *
 * "Availability enforcement: adding a track requires the preview URL to return
 * HTTP 200/206 with a plausible duration." A ranged GET (`Range: bytes=0-1`)
 * is cheap (2 bytes of body) and Deezer answers it with `content-range:
 * bytes 0-1/<total>`, so the *total* byte count — and therefore duration — is
 * knowable without downloading the clip. Deezer previews are 128 kbps CBR MP3;
 * the Phase 0 probe measured every sampled preview at exactly 479 827 bytes ≈
 * 30.0 s (`docs/catalog-probe-report.md`), which is where the CBR assumption
 * below comes from.
 */

/** 128 kbps CBR ⇒ 16 000 bytes/sec. */
const PREVIEW_BITRATE_BYTES_PER_SEC = 128_000 / 8;

/**
 * Sanity bounds on the *measured* duration, not a re-statement of "previews are
 * 30 s": a future catalog swap (ADR-0001) or a Deezer format change could shift
 * the nominal length, and these bounds exist only to catch a mis-parsed
 * `content-range` or a genuinely broken (near-zero-byte) file, not to enforce
 * exactly 30 s.
 */
export const MIN_PLAUSIBLE_PREVIEW_MS = 3_000;
export const MAX_PLAUSIBLE_PREVIEW_MS = 90_000;

export interface PreviewCheckResult {
	/** True only when the ranged GET succeeded (200/206) AND the derived duration is plausible. */
	ok: boolean;
	status: number;
	/** Null when the response carried no usable `content-range` (or the request failed outright). */
	durationMs: number | null;
}

/** Parses `bytes 0-1/479827` → `479827`. Returns `null` for anything else. */
export function totalBytesFromContentRange(headerValue: string | null): number | null {
	if (!headerValue) return null;
	const match = /^bytes\s+\d+-\d+\/(\d+)$/.exec(headerValue.trim());
	if (!match) return null;
	const total = Number(match[1]);
	return Number.isFinite(total) && total > 0 ? total : null;
}

export function durationMsFromByteCount(totalBytes: number): number {
	return Math.round((totalBytes / PREVIEW_BITRATE_BYTES_PER_SEC) * 1000);
}

/**
 * Ranged GET against a preview URL. This is the check MUS-5 requires **at
 * quiz-assembly time**: a track whose preview fails this is refused at add
 * time (`assembly.ts`), so a quiz can never be saved containing a known-dead
 * clip.
 *
 * ADR-0001 obligation: this reads 2 bytes and discards them — it is not audio
 * storage or proxying, and the caller must not persist the response body.
 */
export async function checkPreviewAvailability(
	previewUrl: string,
	fetchImpl: typeof fetch = fetch
): Promise<PreviewCheckResult> {
	try {
		const res = await fetchImpl(previewUrl, {
			method: 'GET',
			headers: { Range: 'bytes=0-1' }
		});
		// Drain the (2-byte) body so the connection doesn't hang open; never persisted.
		await res.arrayBuffer().catch(() => undefined);

		if (res.status !== 200 && res.status !== 206) {
			return { ok: false, status: res.status, durationMs: null };
		}

		const totalBytes = totalBytesFromContentRange(res.headers.get('content-range'));
		if (totalBytes === null) {
			// A 200 without a usable content-range means we can't measure duration —
			// refuse rather than guess (a creator gets a clear "couldn't verify" message).
			return { ok: false, status: res.status, durationMs: null };
		}

		const durationMs = durationMsFromByteCount(totalBytes);
		const plausible =
			durationMs >= MIN_PLAUSIBLE_PREVIEW_MS && durationMs <= MAX_PLAUSIBLE_PREVIEW_MS;
		return { ok: plausible, status: res.status, durationMs };
	} catch {
		return { ok: false, status: 0, durationMs: null };
	}
}
