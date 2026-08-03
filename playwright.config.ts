import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.e2e.{ts,js}',
	webServer: { command: 'pnpm run build && pnpm run preview', port: 4173 },
	// The solo-play suite (task 1.30) preloads real (synthesized) audio and
	// waits out 3-2-1 countdowns and clip playback for the live-region
	// ordering assertions — comfortably longer than Playwright's 30 s default
	// for a handful of the heavier specs (a full 10-round quiz, twice: once
	// pointer-driven, once keyboard-only).
	timeout: 90_000,
	expect: {
		// Generous relative to the default 5 s: the preload gate decodes up to
		// ten ~30 s tone WAVs before the first round renders (MUS-7).
		timeout: 15_000
	},
	// Timing-sensitive assertions (the live-region "reveal never arrives before
	// clip end" check, ROUND-2/A11Y-2) are worth more than wall-clock speed
	// here — run serially rather than risk CPU contention between workers
	// smearing the audio clock the whole suite depends on.
	fullyParallel: false,
	workers: 1,
	use: {
		launchOptions: {
			args: [
				// Headless Chromium's autoplay gate can be inconsistent about
				// treating Playwright's synthetic user gestures as "real" —
				// this removes the gate outright so `AudioEngine.unlock()`
				// (play/[quizId]/+page.svelte's module doc: must run
				// synchronously inside the "start quiz" tap) reliably resumes
				// the `AudioContext` in CI, matching what a real tap does on
				// a device.
				'--autoplay-policy=no-user-gesture-required'
			]
		}
	}
});
