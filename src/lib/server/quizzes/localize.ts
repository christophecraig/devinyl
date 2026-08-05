/**
 * LOC-3: "Official quiz names/descriptions are localized." Only `official`/
 * `daily` quizzes carry the `name_fr`/`name_en`/`description_fr`/
 * `description_en` columns (set at publish, `admin/index.ts`) — a
 * `manual`/`generated` quiz's `name`/`description` is free text the owner
 * typed and is never translated.
 */
import type { Locale } from '$lib/paraglide/runtime.js';

interface LocalizableQuiz {
	kind: 'manual' | 'generated' | 'official' | 'daily';
	name: string;
	description: string | null;
	nameFr: string | null;
	nameEn: string | null;
	descriptionFr: string | null;
	descriptionEn: string | null;
}

function isLocalizedKind(kind: LocalizableQuiz['kind']): boolean {
	return kind === 'official' || kind === 'daily';
}

export function localizedQuizName(quiz: LocalizableQuiz, locale: Locale): string {
	if (!isLocalizedKind(quiz.kind)) return quiz.name;
	const localized = locale === 'fr' ? quiz.nameFr : quiz.nameEn;
	return localized ?? quiz.name;
}

export function localizedQuizDescription(quiz: LocalizableQuiz, locale: Locale): string | null {
	if (!isLocalizedKind(quiz.kind)) return quiz.description;
	const localized = locale === 'fr' ? quiz.descriptionFr : quiz.descriptionEn;
	return localized ?? quiz.description;
}
