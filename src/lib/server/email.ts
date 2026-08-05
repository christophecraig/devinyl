/**
 * Transactional email — plan deviation table (Resend replaces the spec's SMTP
 * relay, ADR-0002) and task 2.1/2.2. Used for Better Auth's verification and
 * password-reset emails.
 *
 * `RESEND_API_KEY` is a [USER] credential (task 2.1) that doesn't exist yet.
 * Rather than let every call site guard for that, this module degrades by
 * itself: with no key, it logs the email instead of sending it, so signup
 * still works end to end in dev/CI — the user just has to read the console
 * for the verification link instead of an inbox.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export interface SendEmailInput {
	to: string;
	subject: string;
	html: string;
}

export async function sendEmail(apiKey: string | undefined, input: SendEmailInput): Promise<void> {
	if (!apiKey) {
		console.warn(
			`[email] RESEND_API_KEY not set — would have sent "${input.subject}" to ${input.to}:\n${input.html}`
		);
		return;
	}

	const res = await fetch(RESEND_ENDPOINT, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			from: 'Devinyl <noreply@devinyl.app>',
			to: [input.to],
			subject: input.subject,
			html: input.html
		})
	});

	if (!res.ok) {
		const body = await res.text().catch(() => '');
		console.error(`[email] Resend send failed (${res.status}): ${body}`);
	}
}
