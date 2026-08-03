import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import pkg from '../../../../package.json' with { type: 'json' };

export const GET: RequestHandler = async () => {
	return json({ ok: true, version: pkg.version });
};
