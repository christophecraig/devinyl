#!/usr/bin/env node
/**
 * Generates e2e/fixtures/*.wav — task 1.29.
 *
 * Synthesized tones only, no copyrighted audio in the repo. `ffmpeg`/`lame`
 * are not available in this environment, so fixtures are plain PCM WAV: a
 * hand-written RIFF header + samples, no encoder dependency. `AudioContext
 * .decodeAudioData` handles WAV natively, so this is a fine stand-in for the
 * Deezer-served MP3s in tests that don't care about the container format.
 *
 * Run: `node scripts/make-fixtures.mjs`
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'e2e', 'fixtures');
// Low but decode-safe sample rate: keeps fixtures small (a 30 s tone lands close to
// the ~480 KB/clip Deezer estimate in §4) without any lossy encoder dependency.
const SAMPLE_RATE = 11_025;

/** Encodes `samples` (Float32, [-1, 1]) as a mono 16-bit PCM WAV file body. */
function encodeWav(samples, sampleRate) {
	const bytesPerSample = 2;
	const blockAlign = bytesPerSample; // mono
	const byteRate = sampleRate * blockAlign;
	const dataSize = samples.length * bytesPerSample;
	const buffer = Buffer.alloc(44 + dataSize);

	buffer.write('RIFF', 0, 'ascii');
	buffer.writeUInt32LE(36 + dataSize, 4);
	buffer.write('WAVE', 8, 'ascii');

	buffer.write('fmt ', 12, 'ascii');
	buffer.writeUInt32LE(16, 16); // fmt chunk size
	buffer.writeUInt16LE(1, 20); // PCM
	buffer.writeUInt16LE(1, 22); // mono
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(byteRate, 28);
	buffer.writeUInt16LE(blockAlign, 32);
	buffer.writeUInt16LE(16, 34); // bits per sample

	buffer.write('data', 36, 'ascii');
	buffer.writeUInt32LE(dataSize, 40);

	for (let i = 0; i < samples.length; i++) {
		const clamped = Math.max(-1, Math.min(1, samples[i]));
		buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * bytesPerSample);
	}

	return buffer;
}

/** A sine tone with a short fade in/out so decoders never trip on a hard-edged click. */
function makeTone(frequencyHz, durationSeconds, sampleRate = SAMPLE_RATE) {
	const total = Math.round(durationSeconds * sampleRate);
	const fadeSamples = Math.min(Math.round(0.02 * sampleRate), Math.floor(total / 10));
	const samples = new Float32Array(total);
	for (let i = 0; i < total; i++) {
		const t = i / sampleRate;
		let amplitude = 0.5;
		if (i < fadeSamples) amplitude *= i / fadeSamples;
		else if (i > total - fadeSamples) amplitude *= (total - i) / fadeSamples;
		samples[i] = amplitude * Math.sin(2 * Math.PI * frequencyHz * t);
	}
	return samples;
}

mkdirSync(OUT_DIR, { recursive: true });

const fixtures = [
	// Vary frequency per fixture so tests can tell rounds apart without reading metadata.
	{ file: 'tone-a-440hz-30s.wav', frequencyHz: 440, durationSeconds: 30 },
	{ file: 'tone-b-880hz-30s.wav', frequencyHz: 880, durationSeconds: 30 },
	{ file: 'tone-c-220hz-30s.wav', frequencyHz: 220, durationSeconds: 30 },
	// Short clip: proves the scoring curve uses the *measured* buffer duration
	// rather than an assumed 30 000 ms denominator (§9).
	{ file: 'tone-short-660hz-5s.wav', frequencyHz: 660, durationSeconds: 5 }
];

for (const { file, frequencyHz, durationSeconds } of fixtures) {
	const wav = encodeWav(makeTone(frequencyHz, durationSeconds), SAMPLE_RATE);
	writeFileSync(join(OUT_DIR, file), wav);
	console.log(`wrote ${file} (${(wav.length / 1024).toFixed(1)} KiB)`);
}

// Deliberately-corrupt file: valid-looking name, garbage bytes — exercises the
// decode-failure → skipped-round path (MUS-5) end to end.
const corruptPath = join(OUT_DIR, 'corrupt.wav');
const corrupt = Buffer.from('RIFF\x00\x00\x00\x00WAVEnot-a-real-fmt-chunk-at-all', 'binary');
writeFileSync(corruptPath, corrupt);
console.log(`wrote corrupt.wav (${corrupt.length} bytes, intentionally undecodable)`);
