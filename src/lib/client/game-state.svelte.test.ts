/**
 * Unit tests for the gameplay state machine (src/lib/client/game-state.svelte.ts).
 *
 * Ports are entirely fake: `now()` reads a mutable counter the test drives by
 * hand (never a real timer), `playClip`/`stopClip` are spies, and the
 * `openRoundPack`/`match` machinery is exercised for real against sealed
 * packs built with `sealRoundPack` — so a "guess matches" here is the same
 * normalize()+match() path the server re-validates with (ANS-4).
 */

import { describe, expect, it, vi } from 'vitest';
import { createGame, type Game, type GamePhase, type GamePorts } from './game-state.svelte.js';
import { sealRoundPack, generateSessionSeed } from '../answerpack.js';
import {
	DEFAULT_QUIZ_SETTINGS,
	type ManifestRound,
	type RoundPack,
	type SessionManifest,
	type QuizSettings
} from '../game/types.js';

async function buildRound(
	sessionSeed: string,
	position: number,
	overrides: Partial<RoundPack['reveal']> = {},
	answers: RoundPack['answers'] = { title: ['title'], artist: ['artist'] }
): Promise<ManifestRound> {
	const pack: RoundPack = {
		answers,
		reveal: {
			title: 'Title',
			artists: ['Artist'],
			albumTitle: 'Album',
			coverUrl: null,
			releaseYear: 2000,
			...overrides
		}
	};
	const answerPack = await sealRoundPack(sessionSeed, position, pack);
	return {
		position,
		previewUrl: `https://example.test/clip-${position}.mp3`,
		skipped: false,
		choices: null,
		answerPack
	};
}

async function buildManifest(
	roundCount: number,
	settings: Partial<QuizSettings> = {}
): Promise<SessionManifest> {
	const sessionSeed = generateSessionSeed();
	const rounds: ManifestRound[] = [];
	for (let i = 0; i < roundCount; i++) {
		rounds.push(await buildRound(sessionSeed, i));
	}
	return {
		sessionId: 'session-1',
		quizId: 'quiz-1',
		rounds,
		sessionSeed,
		settings: { ...DEFAULT_QUIZ_SETTINGS, ...settings },
		effectiveScoringMode: 'speed',
		curveVersion: 1
	};
}

interface FakePorts extends GamePorts {
	setNow(ms: number): void;
	playClip: ReturnType<typeof vi.fn<(position: number) => Promise<void>>>;
	stopClip: ReturnType<typeof vi.fn<() => void>>;
	onRoundStart: ReturnType<typeof vi.fn<(position: number) => void>>;
	onRoundResult: ReturnType<typeof vi.fn<GamePorts['onRoundResult']>>;
	onComplete: ReturnType<typeof vi.fn<GamePorts['onComplete']>>;
}

/** A fake clock + ports bundle the test can drive by hand. */
function fakePorts(): FakePorts {
	let elapsed = 0;
	return {
		now: () => elapsed,
		setNow(ms: number) {
			elapsed = ms;
		},
		playClip: vi.fn(async (_position: number) => {}),
		stopClip: vi.fn(() => {}),
		onRoundStart: vi.fn((_position: number) => {}),
		onRoundResult: vi.fn(),
		onComplete: vi.fn()
	};
}

/**
 * Flushes pending async round-start work (openRoundPack + playClip). Web
 * Crypto's `subtle.decrypt` schedules through a real macrotask, not just
 * microtasks, so this waits for the phase to actually change rather than
 * counting ticks. With no `expectPhase`, it just waits out a fixed number of
 * ticks — used to prove that waiting alone changes nothing (manual advance).
 */
async function flush(game: Game, expectPhase?: GamePhase) {
	for (let i = 0; i < 20; i++) {
		if (expectPhase !== undefined && game.phase === expectPhase) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

describe('createGame — happy path', () => {
	it('walks countdown → clip → reveal → scoreboard → next round → summary', async () => {
		const manifest = await buildManifest(2);
		const ports = fakePorts();
		const game = createGame(manifest, ports);

		expect(game.phase).toBe('idle');
		game.start();
		expect(game.phase).toBe('countdown');

		await flush(game, 'clip');
		expect(game.phase).toBe('clip');
		expect(ports.playClip).toHaveBeenCalledWith(0);
		expect(ports.onRoundStart).toHaveBeenCalledWith(0);
		expect(game.revealed).toBeNull(); // MUS-4: not exposed while the clip is live

		ports.setNow(1000);
		game.submitGuess('title', 'Title');
		game.submitGuess('artist', 'Artist');
		expect(game.phase).toBe('reveal'); // ROUND-3: all targets locked → early end
		expect(ports.stopClip).toHaveBeenCalledTimes(1);
		expect(game.revealed).not.toBeNull();
		expect(game.results).toHaveLength(1);
		expect(game.results[0]).toMatchObject({ position: 0, clipMs: 1000, skipped: false });
		expect(ports.onRoundResult).toHaveBeenCalledTimes(1);

		game.advance(); // reveal -> scoreboard
		expect(game.phase).toBe('scoreboard');

		game.advance(); // scoreboard -> next round's countdown
		expect(game.phase).toBe('countdown');
		expect(game.roundIndex).toBe(1);
		expect(game.revealed).toBeNull(); // reset for the new round
		expect(game.lockedTargets).toEqual([]);

		await flush(game, 'clip');
		expect(game.phase).toBe('clip');
		ports.setNow(500);
		game.submitGuess('title', 'Title');
		game.submitGuess('artist', 'Artist');
		expect(game.phase).toBe('reveal');

		game.advance(); // reveal -> scoreboard
		game.advance(); // scoreboard, last round -> summary
		expect(game.phase).toBe('summary');
		expect(ports.onComplete).toHaveBeenCalledWith(game.results);
		expect(game.results).toHaveLength(2);
	});
});

describe('createGame — locking and rejection', () => {
	it('logs rejected guesses without locking, and requires every target for guessTarget=both', async () => {
		const manifest = await buildManifest(1);
		const ports = fakePorts();
		const game = createGame(manifest, ports);

		game.start();
		await flush(game, 'clip');

		ports.setNow(200);
		game.submitGuess('title', 'wrong answer entirely');
		expect(game.phase).toBe('clip'); // rejected: no lock, round still live
		expect(game.lockedTargets).toEqual([]);

		ports.setNow(300);
		game.submitGuess('title', 'Title');
		expect(game.lockedTargets).toEqual(['title']);
		expect(game.phase).toBe('clip'); // artist still open

		ports.setNow(400);
		game.submitGuess('artist', 'nope');
		expect(game.phase).toBe('clip');

		ports.setNow(500);
		game.submitGuess('artist', 'Artist');
		expect(game.phase).toBe('reveal');

		const [result] = game.results;
		expect(result.guessLog).toHaveLength(4);
		expect(result.guessLog[0]).toMatchObject({ target: 'title', atMs: 200 });
		expect(result.lockTimes).toEqual({ title: 300, artist: 500 });
	});

	it('requires only the title when guessTarget=title', async () => {
		const manifest = await buildManifest(1, { guessTarget: 'title' });
		const ports = fakePorts();
		const game = createGame(manifest, ports);

		game.start();
		await flush(game, 'clip');

		ports.setNow(150);
		game.submitGuess('title', 'Title');
		expect(game.phase).toBe('reveal'); // locking title alone ends the round
		expect(game.results[0].lockTimes).toEqual({ title: 150 });
	});

	it('rejects a guess for a target that is not required', async () => {
		const manifest = await buildManifest(1, { guessTarget: 'title' });
		const game = createGame(manifest, fakePorts());
		game.start();
		await flush(game, 'clip');
		expect(() => game.submitGuess('artist', 'Artist')).toThrow();
	});
});

describe('createGame — skipped rounds', () => {
	it('sends a round with previewUrl=null straight to reveal, no clip, no guessing', async () => {
		const sessionSeed = generateSessionSeed();
		const normal = await buildRound(sessionSeed, 1);
		const pack: RoundPack = {
			answers: { title: ['title'], artist: ['artist'] },
			reveal: {
				title: 'Title',
				artists: ['Artist'],
				albumTitle: 'Album',
				coverUrl: null,
				releaseYear: null
			}
		};
		const skippedRound: ManifestRound = {
			position: 0,
			previewUrl: null,
			skipped: true,
			choices: null,
			answerPack: await sealRoundPack(sessionSeed, 0, pack)
		};
		const manifest: SessionManifest = {
			sessionId: 's',
			quizId: 'q',
			rounds: [skippedRound, normal],
			sessionSeed,
			settings: { ...DEFAULT_QUIZ_SETTINGS },
			effectiveScoringMode: 'speed',
			curveVersion: 1
		};
		const ports = fakePorts();
		const game = createGame(manifest, ports);

		game.start();
		await flush(game, 'reveal');

		expect(game.phase).toBe('reveal');
		expect(ports.playClip).not.toHaveBeenCalled();
		expect(game.revealed).not.toBeNull();
		expect(game.results[0]).toMatchObject({ position: 0, skipped: true, clipMs: 0, guessLog: [] });

		expect(() => game.submitGuess('title', 'Title')).toThrow(); // no guessing on a skipped round
	});
});

describe('createGame — manual advance', () => {
	it('never auto-advances past scoreboard', async () => {
		const manifest = await buildManifest(1);
		const ports = fakePorts();
		const game = createGame(manifest, ports);

		game.start();
		await flush(game, 'clip');
		game.submitGuess('title', 'Title');
		game.submitGuess('artist', 'Artist');
		expect(game.phase).toBe('reveal');

		// Waiting does nothing on its own — advance() is the only way forward.
		await flush(game);
		expect(game.phase).toBe('reveal');

		game.advance();
		expect(game.phase).toBe('scoreboard');
		await flush(game);
		expect(game.phase).toBe('scoreboard');
		expect(ports.onComplete).not.toHaveBeenCalled();
	});

	it('rejects advance() during clip rather than silently dropping it', async () => {
		const manifest = await buildManifest(1);
		const game = createGame(manifest, fakePorts());
		game.start();
		await flush(game, 'clip');
		expect(game.phase).toBe('clip');
		expect(() => game.advance()).toThrow();
	});

	it('rejects submitGuess() outside clip', () => {
		const manifest_promise = buildManifest(1);
		return manifest_promise.then((manifest) => {
			const game = createGame(manifest, fakePorts());
			expect(() => game.submitGuess('title', 'x')).toThrow(); // still idle
		});
	});
});

describe('createGame — answer pack secrecy', () => {
	it('does not expose the answer pack before the round ends', async () => {
		const manifest = await buildManifest(1);
		const game = createGame(manifest, fakePorts());

		expect(game.revealed).toBeNull();
		game.start();
		expect(game.revealed).toBeNull(); // countdown
		await flush(game, 'clip');
		expect(game.phase).toBe('clip');
		expect(game.revealed).toBeNull(); // clip playing — still not exposed

		game.submitGuess('title', 'Title');
		game.submitGuess('artist', 'Artist');
		expect(game.phase).toBe('reveal');
		expect(game.revealed).not.toBeNull(); // only now, round is over
		expect(game.revealed?.reveal.title).toBe('Title');
	});
});

describe('createGame — natural clip end', () => {
	it('ends the round at buffer end via notifyClipEnded() when not all targets locked', async () => {
		const manifest = await buildManifest(1);
		const ports = fakePorts();
		const game = createGame(manifest, ports);

		game.start();
		await flush(game, 'clip');
		game.reportClipDuration(30000);

		ports.setNow(12000);
		game.submitGuess('title', 'Title'); // only title locks

		ports.setNow(30000);
		game.notifyClipEnded();

		expect(game.phase).toBe('reveal');
		expect(game.results[0]).toMatchObject({ clipMs: 30000, skipped: false });
		expect(game.results[0].lockTimes).toEqual({ title: 12000 });
	});
});

describe('createGame — abandon', () => {
	it('leaves the machine unusable (ROUND-8)', async () => {
		const manifest = await buildManifest(2);
		const ports = fakePorts();
		const game = createGame(manifest, ports);

		game.start();
		await flush(game, 'clip');
		game.submitGuess('title', 'wrong');

		game.abandon();
		expect(game.phase).toBe('abandoned');
		expect(ports.stopClip).toHaveBeenCalled();

		expect(() => game.submitGuess('title', 'Title')).toThrow();
		expect(() => game.advance()).toThrow();
		expect(() => game.start()).toThrow();
		expect(() => game.abandon()).toThrow();
		expect(ports.onComplete).not.toHaveBeenCalled();
	});

	it('stops a mid-clip abandon from resolving into a stale round transition', async () => {
		const manifest = await buildManifest(2);
		const ports = fakePorts();
		const game = createGame(manifest, ports);

		game.start(); // still awaiting playClip/openRoundPack
		game.abandon();
		await flush(game);

		expect(game.phase).toBe('abandoned');
	});
});
