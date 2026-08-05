import { describe, expect, it } from 'vitest';
import { buildChallengeShareText, buildDailyShareText } from './share.js';

describe('buildDailyShareText (DAILY-3)', () => {
	it('never includes anything but the day number, score, an emoji row, and the url', () => {
		const text = buildDailyShareText({
			dayNumber: 42,
			totalScore: 850,
			rounds: [
				{ skipped: false, titleOk: true, artistOk: true },
				{ skipped: false, titleOk: true, artistOk: false },
				{ skipped: false, titleOk: false, artistOk: false },
				{ skipped: true, titleOk: null, artistOk: null }
			],
			url: 'https://devinyl.example/daily'
		});

		expect(text).toBe('Devinyl #42 — 850 pts\n🟩🟨🟥⬛\nhttps://devinyl.example/daily');
	});

	it('scores a skipped round as red/black regardless of position', () => {
		const text = buildDailyShareText({
			dayNumber: 1,
			totalScore: 0,
			rounds: [{ skipped: true, titleOk: null, artistOk: null }],
			url: 'https://x'
		});
		expect(text).toContain('⬛');
	});

	it('title-only quizzes (artistOk always null) still resolve full-green on a correct guess', () => {
		const text = buildDailyShareText({
			dayNumber: 1,
			totalScore: 100,
			rounds: [{ skipped: false, titleOk: true, artistOk: null }],
			url: 'https://x'
		});
		expect(text).toContain('🟩');
	});
});

describe('buildChallengeShareText (CHAL-1, SHARE-4)', () => {
	it('carries the nickname and score to beat, never track data', () => {
		const text = buildChallengeShareText({
			challengerName: 'Théo',
			scoreToBeat: 940,
			url: 'https://devinyl.example/c/abc123'
		});
		expect(text).toBe('Théo scored 940 pts on Devinyl. Beat it?\nhttps://devinyl.example/c/abc123');
	});
});
