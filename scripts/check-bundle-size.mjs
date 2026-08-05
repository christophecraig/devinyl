#!/usr/bin/env node
/**
 * Bundle-size budget gate — plan task 4.3, §4 table: "Initial JS (gzip,
 * landing/play route) < 60 KB". Runs after `pnpm run build`, against the
 * real Vite client manifest, so it tracks whatever the router actually ships
 * on first paint rather than a hand-maintained file list.
 *
 * "Initial JS" here means: the SvelteKit client entry (`entry/start`), the
 * app runtime (`entry/app`), and the route's layout + leaf nodes (root
 * layout [0], the error boundary [1], and the route's own leaf) — walked
 * transitively through `imports` (static deps the browser fetches on load),
 * deliberately excluding `dynamicImports` (other routes' code, only fetched
 * on navigation to them and not part of this route's first paint).
 *
 * Deliberately a one-off script, not a general bundlesize tool: two routes,
 * one budget, read once per CI run. If more routes need budgets later,
 * extend the ROUTES list below rather than reaching for a dependency.
 */

import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const CLIENT_DIR = '.svelte-kit/output/client';
const SERVER_MANIFEST = '.svelte-kit/output/server/manifest.js';
const MANIFEST_JSON = path.join(CLIENT_DIR, '.vite/manifest.json');
const BUDGET_BYTES = 60 * 1024; // §4 table: 60 KB gzip

// Routes covering the "landing/play route" the §4 table calls out: the
// landing page is the first thing every player hits, and the play route is
// where MUS-1..7's round loop actually runs — both are on the critical path
// to "hear a clip", so both get the same budget rather than picking one.
const ROUTES = [
	{ label: 'landing (/)', id: '/(app)' },
	{ label: 'play (/play/[quizId])', id: '/(app)/play/[quizId]' }
];

function fail(message) {
	console.error(`✗ ${message}`);
	process.exitCode = 1;
}

if (!existsSync(MANIFEST_JSON) || !existsSync(SERVER_MANIFEST)) {
	fail(
		`Build output not found (expected ${MANIFEST_JSON} and ${SERVER_MANIFEST}). Run \`pnpm run build\` first.`
	);
	process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST_JSON, 'utf8'));
const serverManifestSrc = readFileSync(SERVER_MANIFEST, 'utf8');

function findEntryKey(fileSubstring) {
	const entry = Object.entries(manifest).find(([, v]) => v.file?.includes(fileSubstring));
	if (!entry) throw new Error(`No manifest entry with file matching "${fileSubstring}"`);
	return entry[0];
}

// The SvelteKit client entry and the app runtime are always present and
// always part of first paint, regardless of route.
const startKey = findEntryKey('entry/start.');
const appKey = findEntryKey('entry/app.');

function nodeKey(index) {
	return `.svelte-kit/generated/client-optimized/nodes/${index}.js`;
}

/** Pull { layouts, errors, leaf } node indices for a route id out of the
 * server manifest's route table (`page: { layouts: [0,], errors: [1,], leaf: 2 }`). */
function resolveRouteNodes(routeId) {
	const escaped = routeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const re = new RegExp(
		`id: "${escaped}",[\\s\\S]*?page: \\{ layouts: \\[([^\\]]*)\\], errors: \\[([^\\]]*)\\], leaf: (\\d+) \\}`
	);
	const match = serverManifestSrc.match(re);
	if (!match) throw new Error(`Route "${routeId}" not found in ${SERVER_MANIFEST}`);
	const layouts = match[1]
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.map(Number);
	const leaf = Number(match[3]);
	return [...layouts, leaf];
}

/** Transitive closure over static `imports` only (never `dynamicImports` —
 * those are other routes, fetched on navigation, not first paint). */
function collectImports(entryKey, seen) {
	if (seen.has(entryKey)) return;
	seen.add(entryKey);
	const entry = manifest[entryKey];
	if (!entry) throw new Error(`Manifest entry not found: ${entryKey}`);
	for (const imp of entry.imports ?? []) collectImports(imp, seen);
}

function gzipSizeOf(clientRelativeFile) {
	const file = path.join(CLIENT_DIR, clientRelativeFile);
	const buf = readFileSync(file);
	return gzipSync(buf, { level: 9 }).length;
}

let anyFail = false;

for (const route of ROUTES) {
	const nodeIndices = resolveRouteNodes(route.id);
	const entryKeys = [startKey, appKey, ...nodeIndices.map(nodeKey)];

	const seen = new Set();
	for (const key of entryKeys) collectImports(key, seen);

	const files = [];
	let totalGzip = 0;
	for (const key of seen) {
		const entry = manifest[key];
		if (!entry?.file?.endsWith('.js')) continue; // CSS ships separately from the "JS" budget
		const gz = gzipSizeOf(entry.file);
		totalGzip += gz;
		files.push({ file: entry.file, gz });
	}
	files.sort((a, b) => b.gz - a.gz);

	const kb = (n) => (n / 1024).toFixed(2);
	const pass = totalGzip <= BUDGET_BYTES;
	console.log(`\n${route.label}: ${kb(totalGzip)} KB gzip (budget ${kb(BUDGET_BYTES)} KB)`);
	for (const f of files) console.log(`  ${kb(f.gz)} KB  ${f.file}`);

	if (!pass) {
		anyFail = true;
		fail(
			`${route.label} exceeds the 60 KB initial-JS budget (§4 table): ${kb(totalGzip)} KB gzip.`
		);
	} else {
		console.log(`✓ ${route.label} within budget`);
	}
}

if (anyFail) {
	console.error(
		'\nBundle-size budget failed. See docs/implementation-plan.md task 4.3 for the current, honestly-reported baseline and what is (not yet) trimmed.'
	);
	process.exit(1);
}
