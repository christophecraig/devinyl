/**
 * LOC-3: dates, numbers, and rank formats follow the active locale.
 * Thin wrappers over `Intl`, keyed off Paraglide's `getLocale()` so every
 * caller stays in sync with the cookie/Accept-Language resolution in
 * hooks.server.ts without importing the runtime directly everywhere.
 */
import { getLocale } from '$lib/paraglide/runtime.js';

export function formatNumber(value: number): string {
	return new Intl.NumberFormat(getLocale()).format(value);
}

/** Ordinal rank, e.g. "1st"/"2nd"/"3rd" (en) or "1er"/"2e" (fr). */
export function formatRank(rank: number): string {
	const rules = new Intl.PluralRules(getLocale(), { type: 'ordinal' });
	const category = rules.select(rank);
	const suffixes: Record<string, Record<string, string>> = {
		en: { one: 'st', two: 'nd', few: 'rd', other: 'th' },
		fr: { one: rank === 1 ? 'er' : 'e', other: 'e' }
	};
	const locale = getLocale();
	const suffix = suffixes[locale]?.[category] ?? suffixes[locale]?.other ?? '';
	return `${rank}${suffix}`;
}

export function formatDate(value: Date | number, options?: Intl.DateTimeFormatOptions): string {
	return new Intl.DateTimeFormat(getLocale(), options).format(value);
}
