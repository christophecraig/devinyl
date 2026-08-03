/**
 * Name filter — FAIR-5, technical-spec §11.
 *
 * Data lives in `./profanity/{fr,en}.json`; the rules that govern what may go
 * in which list (and the Scunthorpe analysis behind every `substring` entry)
 * are in `./profanity/README.md`. This module is only the matcher.
 *
 * Three things the README asks for and this file honors:
 *
 *   1. Matching runs on the **normalized** form (§8.1) — the same shared
 *      `normalize()` the game engine uses, never a second pipeline.
 *   2. `allowlist` wins over `substring`. The allowlisted span is *stripped*
 *      before the substring pass rather than short-circuiting the whole check,
 *      so `scunthorpe` passes but `scunthorpefuck` still fails.
 *   3. Rejection is a friendly message and never says what matched.
 *
 * Both language lists are always checked. A French player can pick an English
 * slur and vice versa, and the board is one shared surface — so locale selects
 * the *message*, never which words are allowed.
 */

import { normalize } from '$lib/game/normalize.js';
import en from './profanity/en.json' with { type: 'json' };
import fr from './profanity/fr.json' with { type: 'json' };

interface Blocklist {
	exact: string[];
	substring: string[];
	allowlist?: string[];
}

const LISTS: Blocklist[] = [fr as Blocklist, en as Blocklist];

const EXACT = new Set(LISTS.flatMap((l) => l.exact));
const SUBSTRINGS = LISTS.flatMap((l) => l.substring);
const ALLOWLIST = LISTS.flatMap((l) => l.allowlist ?? []);

/**
 * Removes every allowlisted span from the normalized name, so a legitimate
 * host word can't carry a banned stem into the substring pass — while anything
 * *else* in the name is still checked (README, "Allowlist precedence").
 */
function stripAllowlisted(normalized: string): string {
	let remaining = normalized;
	for (const allowed of ALLOWLIST) {
		if (!allowed) continue;
		remaining = remaining.split(allowed).join(' ');
	}
	return remaining;
}

/** True when the name may not be used. Never explains itself — see `nameRejectionMessage`. */
export function isBlockedName(name: string): boolean {
	const normalized = normalize(name);
	if (!normalized) return false;

	// `exact`: the whole normalized string, or any single token within it. Phrase
	// entries ("fils de pute") only ever match the whole-string form, which is
	// what the README's "whole normalized string of consecutive tokens" means for
	// a nickname of this length.
	if (EXACT.has(normalized)) return true;
	for (const token of normalized.split(' ')) {
		if (EXACT.has(token)) return true;
	}

	const searchable = stripAllowlisted(normalized);
	return SUBSTRINGS.some((stem) => stem && searchable.includes(stem));
}

/**
 * The player-facing rejection (FAIR-5): friendly, and deliberately silent about
 * what matched — naming the trigger both teaches evasion and reads as an
 * accusation for the false positives a blocklist inevitably produces.
 */
export function nameRejectionMessage(locale: 'fr' | 'en' = 'fr'): string {
	return locale === 'fr'
		? 'Ce pseudo n’est pas disponible. Choisis-en un autre.'
		: 'That name isn’t available. Please choose a different one.';
}
