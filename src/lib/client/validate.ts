/**
 * Client-side shape checks — hand-rolled instead of importing `zod` so it never
 * enters the client bundle (`$lib/game/schemas.ts` stays the server-side source
 * of truth; keep these in sync with it by hand if those regexes/bounds change).
 */

const ID_RE = /^[A-Za-z0-9_-]{12}$/;
const GUEST_ID_RE = /^[A-Za-z0-9_-]{8,32}$/;
const NICKNAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u;

export function isId(value: unknown): value is string {
	return typeof value === 'string' && ID_RE.test(value);
}

export function isGuestId(value: unknown): value is string {
	return typeof value === 'string' && GUEST_ID_RE.test(value);
}

export function isNonNegInt(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Mirrors `nicknameSchema.safeParse` (trim, length, charset) closely enough for client-side use. */
export function validateNickname(
	value: string
): { success: true; data: string } | { success: false } {
	const trimmed = value.trim();
	if (trimmed.length < 2 || trimmed.length > 24) return { success: false };
	if (!NICKNAME_RE.test(trimmed)) return { success: false };
	return { success: true, data: trimmed };
}
