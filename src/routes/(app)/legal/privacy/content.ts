/**
 * Privacy policy prose — plan task 4.5 (LEGAL-3). Written from
 * `docs/data-inventory.md` table by table; every claim below should trace to
 * a row there. French is the authoritative text (French operator, French
 * audience); English is a translation, flagged as such on the page.
 *
 * Kept as plain data (no message-catalog keys) deliberately: this is
 * long-form legal prose, not UI copy, and `messages/en.json` /
 * `messages/fr.json` are owned by another in-flight task while this one is
 * being written.
 */

export interface LegalSection {
	id: string;
	heading: string;
	paragraphs: string[];
	list?: string[];
}

export interface LegalContent {
	documentTitle: string;
	intro: string[];
	translationNote: string | null;
	tocLabel: string;
	lastUpdatedLabel: string;
	sections: LegalSection[];
	contactLabel: string;
	contactIntro: string;
}

export const CONTACT_EMAIL = 'contact@christophecraig.com';
export const LAST_UPDATED = '2026-08-07';

export const fr: LegalContent = {
	documentTitle: 'Politique de confidentialité',
	intro: [
		"Devinyl est un jeu de blind-test musical édité à titre non professionnel par une personne physique, joignable à l'adresse indiquée en fin de page (« nous », « l'éditeur »). Cette politique explique quelles données nous traitons lorsque vous utilisez Devinyl, pourquoi, combien de temps nous les gardons, et comment faire valoir vos droits."
	],
	translationNote:
		'Ce document est rédigé et fait foi en français. Une traduction en anglais est fournie ci-dessous par courtoisie ; en cas de divergence, la version française prévaut.',
	tocLabel: 'Sommaire',
	lastUpdatedLabel: 'Dernière mise à jour',
	sections: [
		{
			id: 'responsable',
			heading: '1. Qui est responsable du traitement',
			paragraphs: [
				"Le responsable du traitement, au sens du RGPD, est l'éditeur de Devinyl, joignable à contact@christophecraig.com. Devinyl n'a pas de délégué à la protection des données désigné : toute question relative à vos données personnelles peut être adressée directement à cette adresse."
			]
		},
		{
			id: 'donnees',
			heading: '2. Quelles données nous collectons, et pourquoi',
			paragraphs: [
				'Nous ne collectons que ce qui est nécessaire au fonctionnement du jeu. Le détail technique complet, table par table, est public dans notre inventaire de données (docs/data-inventory.md du dépôt du projet) ; en voici le résumé en langage clair :'
			],
			list: [
				"Compte joueur : adresse e-mail (identifiant de connexion), pseudonyme public, avatar éventuel, langue préférée, année de naissance (uniquement l'année, pour vérifier que vous avez au moins 13 ans — voir section 8), et une préférence d'accessibilité optionnelle (« saisie étendue ») que nous ne montrons jamais publiquement ni aux autres joueurs.",
				"Identifiants de connexion : un mot de passe haché (jamais en clair) si vous créez un compte par e-mail, ou un jeton d'authentification si vous vous connectez avec Google. Ces éléments servent uniquement à vous authentifier.",
				'Parties jouées : vos scores, la partie jouée, le mode de jeu, et le détail de vos réponses (le texte que vous avez tapé et le temps mis à répondre pour chaque manche), pour calculer votre score et le vérifier côté serveur contre la triche.',
				'Quiz que vous créez : les titres, descriptions et morceaux choisis pour les quiz que vous créez et enregistrez.',
				"Amis : les demandes d'amis envoyées, reçues et acceptées, pour afficher le classement entre amis.",
				'Classement hebdomadaire : votre total de points par semaine et votre meilleur rang, pour le classement hebdomadaire.',
				"Historique importé : si vous jouez d'abord en tant qu'invité puis créez un compte, l'historique de vos parties jouées en local (stocké uniquement sur votre appareil, dans le « localStorage » du navigateur) peut être rattaché à votre compte à votre demande.",
				'Identifiant invité : si vous jouez sans compte, un identifiant technique aléatoire est généré et stocké uniquement dans le navigateur (localStorage), pour vous permettre de continuer une partie ou de relier plus tard votre historique à un compte. Il ne contient aucune information personnelle.',
				"Anti-triche du quiz du jour (invités) : pour empêcher qu'une même connexion ne réclame plusieurs fois la récompense du quiz quotidien sous des identités d'invité différentes, nous calculons un hachage cryptographique de votre adresse IP, salé différemment chaque jour et impossible à inverser ou à relier d'un jour à l'autre. Nous ne stockons jamais votre adresse IP en clair dans une table de la base de données.",
				'Limitation de débit : un compteur technique de nombre de requêtes par minute (par compte, par invité ou par IP), pour éviter les abus (scripts automatisés, spam). Ce compteur ne contient aucun contenu, seulement un nombre.'
			]
		},
		{
			id: 'bases-legales',
			heading: '3. Bases légales du traitement',
			paragraphs: [
				"Les données de compte, de partie et de quiz sont traitées sur la base de l'exécution du contrat qui nous lie à vous dès lors que vous créez un compte ou jouez (fournir le service que vous avez demandé). L'identifiant invité, le hachage anti-triche du quiz du jour et la limitation de débit reposent sur notre intérêt légitime à faire fonctionner un service gratuit sans abus manifeste, avec un impact minimal sur votre vie privée (aucune donnée directement identifiante n'est stockée dans ces deux derniers cas). La création d'un compte via Google repose sur votre consentement exprès au moment de la connexion."
			]
		},
		{
			id: 'conservation',
			heading: '4. Durées de conservation',
			paragraphs: [
				'Nous gardons vos données aussi longtemps que votre compte existe, puis appliquons les durées suivantes après une suppression de compte ou par nature de la donnée :'
			],
			list: [
				"Compte : à la suppression, votre e-mail est remplacé par une valeur non joignable ; sa version d'origine ne survit que 30 jours de plus, sous forme de hachage technique non réversible, uniquement pour empêcher une réinscription immédiate frauduleuse, puis est purgée définitivement.",
				"Parties jouées : conservées indéfiniment mais anonymisées à la suppression du compte (pseudonyme remplacé par « Joueur supprimé », compte détaché) — le score reste sur le classement pour l'intégrité du jeu vis-à-vis des autres joueurs, mais n'est plus rattaché à vous.",
				"Quiz que vous avez créés : conservés indéfiniment tant qu'ils existent ; à la suppression du compte, ils sont détachés de votre identité et marqués comme supprimés plutôt que cassés pour les personnes qui y ont encore accès par un lien. Un quiz généré automatiquement et jamais enregistré est supprimé après 24 heures s'il reste inutilisé.",
				"Amitiés : supprimées immédiatement et définitivement à la suppression de l'un des deux comptes.",
				'Classement hebdomadaire et historique importé : conservés indéfiniment (ce sont des statistiques historiques), supprimés définitivement et immédiatement à la suppression du compte.',
				'Identifiant anti-triche du quiz du jour (invités) : conservé 48 heures puis supprimé automatiquement.',
				'Compteurs de limitation de débit : conservés une à deux heures puis supprimés automatiquement.',
				"Sessions de connexion et jetons d'authentification : supprimés immédiatement à la déconnexion ou à la suppression du compte ; sinon expirent au bout de 30 jours glissants."
			]
		},
		{
			id: 'destinataires',
			heading: '5. Qui a accès à vos données (sous-traitants)',
			paragraphs: [
				'Nous ne vendons aucune donnée. Nous ne partageons pas vos données à des fins publicitaires. Certains prestataires techniques traitent des données pour notre compte, en tant que sous-traitants, dans la stricte mesure nécessaire à la fourniture du service :'
			],
			list: [
				"Cloudflare (hébergement) : héberge l'application et la base de données, et achemine chaque requête via son réseau mondial de serveurs. C'est un sous-traitant technique, pas un partenaire publicitaire.",
				"Resend (envoi d'e-mails) : envoie les e-mails transactionnels du service (vérification d'adresse, réinitialisation de mot de passe) en notre nom.",
				"Google (connexion OAuth) : si vous choisissez de vous connecter avec un compte Google, Google agit comme fournisseur d'identité pour cette seule opération de connexion, selon sa propre politique de confidentialité.",
				"Sentry (suivi des erreurs techniques) : lorsqu'il est activé, un message d'erreur technique et son contexte (par exemple, quelle fonctionnalité a échoué) peuvent lui être transmis pour nous aider à diagnostiquer des bugs. Ce service ne reçoit pas le contenu de vos parties ni vos identifiants."
			]
		},
		{
			id: 'transferts',
			heading: '6. Transferts de données',
			paragraphs: [
				"Cloudflare exploite un réseau de serveurs répartis dans le monde entier ; une requête peut donc être traitée par un serveur situé hors de l'Union européenne, y compris pour des transferts vers des pays tiers, encadrés par les garanties contractuelles standard de Cloudflare. L'emplacement précis de stockage principal de la base de données n'est pas figé à ce jour dans notre configuration technique — c'est un point que nous nous engageons à préciser et, si nécessaire, à corriger lors d'une prochaine mise à jour de cette politique."
			]
		},
		{
			id: 'cookies',
			heading: '7. Cookies',
			paragraphs: [
				"Devinyl n'utilise que des cookies strictement nécessaires au fonctionnement du service : un cookie de session (pour rester connecté) et un cookie de préférence de langue (« PARAGLIDE_LOCALE », conservé environ 400 jours). Aucun cookie publicitaire, de mesure d'audience tierce, ou de traçage inter-sites n'est utilisé. Conformément à la réglementation, aucun bandeau de consentement n'est nécessaire pour ces cookies strictement fonctionnels, et aucun ne s'affiche."
			]
		},
		{
			id: 'pas-de-pub',
			heading: '8. Pas de publicité, pas de profilage, pas de vente de données',
			paragraphs: [
				"Nous ne diffusons aucune publicité, ne faisons aucun profilage comportemental, n'utilisons aucun outil de mesure d'audience tiers, et ne vendons aucune donnée personnelle — ni aujourd'hui, ni prévu pour l'avenir. Les seules statistiques que nous produisons sont des compteurs agrégés (par exemple, nombre de parties jouées un jour donné) qui ne contiennent aucun identifiant de joueur et ne permettent pas de vous identifier."
			]
		},
		{
			id: 'age',
			heading: '9. Âge minimum',
			paragraphs: [
				"La création d'un compte Devinyl est réservée aux personnes âgées d'au moins 13 ans, sur la base d'une déclaration de votre part au moment de l'inscription (nous ne vérifions pas ce point par un moyen tiers). Le jeu en mode invité ne collecte aucune donnée personnelle au-delà d'un pseudonyme choisi et n'est donc soumis à aucune restriction d'âge."
			]
		},
		{
			id: 'droits',
			heading: '10. Vos droits',
			paragraphs: [
				"Conformément au RGPD, vous disposez d'un droit d'accès, de rectification, d'effacement, de limitation, d'opposition et de portabilité de vos données. Vous pouvez exercer la plupart de ces droits directement dans l'application, sans nous contacter :"
			],
			list: [
				'Accès et portabilité : téléchargez un export complet de vos données personnelles au format JSON depuis la page de vos statistiques/paramètres de compte, à tout moment.',
				'Rectification : modifiez votre pseudonyme, avatar, langue ou année de naissance directement dans les paramètres de votre compte.',
				"Effacement : supprimez votre compte directement depuis l'application ; voir la section 4 pour ce qui est réellement effacé, anonymisé, ou conservé le temps strictement nécessaire.",
				'Opposition et limitation : contactez-nous à contact@christophecraig.com.',
				'Réclamation : vous pouvez introduire une réclamation auprès de la CNIL (www.cnil.fr) si vous estimez que vos droits ne sont pas respectés.'
			]
		},
		{
			id: 'securite',
			heading: '11. Sécurité',
			paragraphs: [
				"Les mots de passe sont hachés, jamais stockés en clair. Les connexions au service sont chiffrées (HTTPS). L'accès aux données de production est limité à l'opérateur du service. Aucun système n'étant infaillible, nous nous engageons à vous informer sans retard injustifié en cas de violation de données susceptible d'engendrer un risque élevé pour vos droits et libertés."
			]
		},
		{
			id: 'modifications',
			heading: '12. Modifications de cette politique',
			paragraphs: [
				"Nous pouvons modifier cette politique pour refléter une évolution du service ou de la réglementation. La date de dernière mise à jour en haut de page change à chaque révision ; en cas de changement substantiel, nous nous efforcerons de vous en informer par un moyen raisonnable (par exemple un message dans l'application)."
			]
		}
	],
	contactLabel: '13. Contact',
	contactIntro:
		'Pour toute question relative à cette politique ou à vos données personnelles, écrivez-nous à :'
};

export const en: LegalContent = {
	documentTitle: 'Privacy Policy',
	intro: [
		'Devinyl is a music blind-test game published on a non-professional basis by an individual, reachable at the address given at the end of this page ("we", "the publisher"). This policy explains what data we process when you use Devinyl, why, how long we keep it, and how to exercise your rights.'
	],
	translationNote:
		'This document is written in, and legally governed by, its French version. This English text is provided as a courtesy translation; in case of any discrepancy, the French version prevails.',
	tocLabel: 'Contents',
	lastUpdatedLabel: 'Last updated',
	sections: [
		{
			id: 'responsable',
			heading: '1. Who is the data controller',
			paragraphs: [
				"The data controller, within the meaning of the GDPR, is Devinyl's publisher, reachable at contact@christophecraig.com. Devinyl has no appointed data protection officer: any question about your personal data can be sent directly to that address."
			]
		},
		{
			id: 'donnees',
			heading: '2. What data we collect, and why',
			paragraphs: [
				'We only collect what the game needs to function. The full technical detail, table by table, is public in our data inventory (docs/data-inventory.md in the project repository); here is the plain-language summary:'
			],
			list: [
				'Player account: email address (sign-in identifier), public display name, optional avatar, preferred language, birth year (year only, to check you are at least 13 — see section 8), and an optional accessibility preference ("extended input") we never show publicly or to other players.',
				'Sign-in credentials: a hashed password (never stored in plain text) if you create an account by email, or an authentication token if you sign in with Google. These are used only to authenticate you.',
				'Games played: your scores, which game was played, the game mode, and the detail of your answers (the text you typed and how long each round took), used to compute your score and to re-check it server-side against cheating.',
				'Quizzes you create: the titles, descriptions and tracks chosen for any quiz you create and save.',
				'Friends: friend requests sent, received and accepted, to show the friends leaderboard.',
				'Weekly ladder: your weekly point total and best rank, for the weekly leaderboard.',
				"Imported history: if you first play as a guest and later create an account, your locally-played game history (stored only on your device, in the browser's localStorage) can be attached to your account at your request.",
				'Guest identifier: if you play without an account, a random technical identifier is generated and stored only in your browser (localStorage), so you can resume a game or later attach your history to an account. It carries no personal information.',
				"Daily-quiz anti-cheat for guests: to stop the same connection from claiming the daily quiz's reward multiple times under different guest identities, we compute a cryptographic hash of your IP address, salted differently every day and impossible to reverse or link across days. We never store your raw IP address in a database table.",
				'Rate limiting: a technical counter of how many requests were made per minute (per account, guest, or IP), used to prevent abuse (bots, spam). This counter holds no content, only a number.'
			]
		},
		{
			id: 'bases-legales',
			heading: '3. Legal bases for processing',
			paragraphs: [
				'Account, game, and quiz data are processed on the basis of performance of the contract formed with you when you create an account or play (providing the service you asked for). The guest identifier, the daily-quiz anti-cheat hash, and rate limiting rest on our legitimate interest in running a free service without obvious abuse, with minimal privacy impact (neither stores anything directly identifying). Signing in via Google rests on your explicit consent at the moment you choose that sign-in method.'
			]
		},
		{
			id: 'conservation',
			heading: '4. Retention periods',
			paragraphs: [
				'We keep your data for as long as your account exists, then apply the following after account deletion or by data type:'
			],
			list: [
				'Account: on deletion, your email is replaced with a non-deliverable value; the original survives 30 further days as a one-way technical hash, solely to block instant fraudulent re-registration, then is purged permanently.',
				'Games played: kept indefinitely but anonymized on account deletion (display name replaced with "Deleted player", account unlinked) — the score stays on the board for other players\' board integrity, but is no longer tied to you.',
				'Quizzes you created: kept indefinitely while they exist; on account deletion they are detached from your identity and marked deleted rather than broken for anyone still holding a link to them. A generated-but-never-saved quiz is removed after 24 hours if left unused.',
				'Friendships: deleted immediately and permanently when either account is deleted.',
				'Weekly ladder and imported history: kept indefinitely (historical statistics), permanently and immediately deleted when the account is deleted.',
				'Daily-quiz anti-cheat identifier (guests): kept 48 hours, then automatically deleted.',
				'Rate-limit counters: kept one to two hours, then automatically deleted.',
				'Login sessions and auth tokens: deleted immediately on sign-out or account deletion; otherwise expire on a rolling 30-day basis.'
			]
		},
		{
			id: 'destinataires',
			heading: '5. Who has access to your data (processors)',
			paragraphs: [
				'We do not sell any data. We do not share your data for advertising purposes. Some technical providers process data on our behalf, as processors, strictly to the extent the service needs:'
			],
			list: [
				'Cloudflare (hosting): hosts the application and database, and routes every request through its global server network. A technical processor, not an advertising partner.',
				"Resend (email delivery): sends the service's transactional emails (address verification, password reset) on our behalf.",
				'Google (OAuth sign-in): if you choose to sign in with a Google account, Google acts as identity provider for that sign-in step only, under its own privacy policy.',
				'Sentry (technical error tracking): when enabled, a technical error message and its context (e.g. which feature failed) may be sent to it to help us diagnose bugs. This service does not receive your game content or credentials.'
			]
		},
		{
			id: 'transferts',
			heading: '6. Data transfers',
			paragraphs: [
				"Cloudflare operates a server network spread across the world, so a request may be handled by a server outside the European Union, including transfers to third countries covered by Cloudflare's standard contractual safeguards. The precise primary storage location of the database is not currently pinned in our technical configuration — this is a point we commit to clarifying, and correcting if needed, in a future update to this policy."
			]
		},
		{
			id: 'cookies',
			heading: '7. Cookies',
			paragraphs: [
				'Devinyl only uses cookies that are strictly necessary for the service to work: a session cookie (to keep you signed in) and a language-preference cookie ("PARAGLIDE_LOCALE", kept for about 400 days). No advertising cookie, third-party analytics cookie, or cross-site tracker is used. In line with regulation, no consent banner is required for these strictly functional cookies, and none is shown.'
			]
		},
		{
			id: 'pas-de-pub',
			heading: '8. No advertising, no profiling, no selling data',
			paragraphs: [
				'We run no advertising, do no behavioural profiling, use no third-party analytics tool, and sell no personal data — not today, and none is planned. The only statistics we produce are aggregate counters (e.g. how many games were played on a given day) that hold no player identifier and cannot identify you.'
			]
		},
		{
			id: 'age',
			heading: '9. Minimum age',
			paragraphs: [
				'Creating a Devinyl account is restricted to people aged 13 or older, based on your own declaration at signup (we do not verify this through any third-party means). Guest play collects no personal data beyond a chosen nickname and is therefore not age-restricted.'
			]
		},
		{
			id: 'droits',
			heading: '10. Your rights',
			paragraphs: [
				'Under the GDPR, you have rights of access, rectification, erasure, restriction, objection, and data portability. You can exercise most of these directly in the app, without contacting us:'
			],
			list: [
				'Access and portability: download a full export of your personal data as JSON from your stats/account settings page, at any time.',
				'Rectification: change your display name, avatar, language, or birth year directly in your account settings.',
				'Erasure: delete your account directly from the app; see section 4 for what is actually erased, anonymized, or kept for a strictly necessary period.',
				'Objection and restriction: contact us at contact@christophecraig.com.',
				'Complaint: you may lodge a complaint with your national data protection authority (in France, the CNIL, www.cnil.fr) if you believe your rights are not respected.'
			]
		},
		{
			id: 'securite',
			heading: '11. Security',
			paragraphs: [
				'Passwords are hashed, never stored in plain text. Connections to the service are encrypted (HTTPS). Access to production data is limited to the service operator. No system is infallible; we commit to notifying you without undue delay in the event of a data breach likely to result in a high risk to your rights and freedoms.'
			]
		},
		{
			id: 'modifications',
			heading: '12. Changes to this policy',
			paragraphs: [
				'We may update this policy to reflect changes to the service or to the law. The "last updated" date at the top of this page changes with every revision; for a substantial change, we will make a reasonable effort to let you know (for example, an in-app notice).'
			]
		}
	],
	contactLabel: '13. Contact',
	contactIntro: 'For any question about this policy or your personal data, write to us at:'
};
