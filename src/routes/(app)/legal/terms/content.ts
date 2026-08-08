/**
 * Terms of Service prose — plan task 4.5 (LEGAL-3). See
 * `../privacy/content.ts` for the same conventions (French authoritative,
 * English translation, plain data instead of message-catalog keys because
 * this is long-form legal prose written directly for these two routes).
 */

import type { LegalContent } from '../privacy/content';

export { CONTACT_EMAIL, LAST_UPDATED } from '../privacy/content';

export const fr: LegalContent = {
	documentTitle: "Conditions générales d'utilisation",
	intro: [
		"Les présentes conditions générales d'utilisation (« CGU ») régissent l'accès et l'utilisation de Devinyl, un jeu de blind-test musical. En créant un compte ou en jouant, même en tant qu'invité, vous acceptez les présentes CGU."
	],
	translationNote:
		'Ce document est rédigé et fait foi en français. Une traduction en anglais est fournie ci-dessous par courtoisie ; en cas de divergence, la version française prévaut.',
	tocLabel: 'Sommaire',
	lastUpdatedLabel: 'Dernière mise à jour',
	sections: [
		{
			id: 'service',
			heading: '1. Description du service',
			paragraphs: [
				"Devinyl est un jeu gratuit dans lequel vous devez reconnaître un morceau de musique à partir d'un extrait audio de 30 secondes. Les extraits audio proviennent du catalogue du fournisseur tiers Deezer, via son API publique — Devinyl ne stocke ni n'héberge lui-même les fichiers audio, il les diffuse en direct depuis les serveurs de Deezer. Ces extraits, et les enregistrements dont ils sont issus, restent la propriété de leurs ayants droit respectifs (labels, artistes, éditeurs). Le service est fourni « Powered by Deezer », mention que vous verrez affichée dans l'application. Devinyl n'est ni édité, ni exploité, ni affilié à Deezer.",
				'Devinyl propose également des quiz créés par ses joueurs, un quiz du jour, des classements (général, hebdomadaire, entre amis), et des liens de défi à partager.'
			]
		},
		{
			id: 'comptes',
			heading: '2. Comptes et âge minimum',
			paragraphs: [
				'Vous pouvez jouer sans créer de compte (« invité »), avec un historique limité au navigateur utilisé. Créer un compte permet de sauvegarder votre progression, vos quiz et votre classement de façon durable.',
				"La création d'un compte est réservée aux personnes d'au moins 13 ans, sur la base d'une déclaration sur l'honneur au moment de l'inscription. Vous êtes responsable de l'exactitude des informations fournies et de la confidentialité de votre mot de passe."
			]
		},
		{
			id: 'usage-loyal',
			heading: '3. Usage loyal du service',
			paragraphs: ['En utilisant Devinyl, vous vous engagez à ne pas :'],
			list: [
				"Utiliser des scripts, bots, ou toute forme d'automatisation pour jouer, deviner, ou fausser un score ou un classement ;",
				'Contourner ou tenter de contourner les mécanismes de vérification côté serveur des réponses et des scores ;',
				"Choisir un pseudonyme, un titre ou une description de quiz injurieux, obscène, discriminatoire, usurpant l'identité d'un tiers, ou autrement illicite ;",
				"Tenter d'accéder aux données d'un autre compte, ou de perturber le fonctionnement du service (surcharge délibérée, tentative d'intrusion)."
			]
		},
		{
			id: 'quiz-utilisateurs',
			heading: '4. Quiz créés par les utilisateurs',
			paragraphs: [
				"Si vous créez un quiz, vous restez propriétaire des titres et descriptions que vous rédigez. En les publiant sur Devinyl, vous nous accordez une licence non exclusive, gratuite et mondiale pour les afficher, les distribuer via un lien partageable, et les faire apparaître dans le service (y compris auprès d'autres joueurs), aussi longtemps que le quiz existe.",
				'Nous nous réservons le droit de retirer, sans préavis, tout quiz (ou pseudonyme, ou contenu) qui enfreint les présentes CGU ou la loi, notamment en cas de signalement.'
			]
		},
		{
			id: 'disponibilite',
			heading: '5. Disponibilité du service',
			paragraphs: [
				"Devinyl est un service gratuit, fourni « en l'état », sans garantie de disponibilité continue ni d'absence d'erreur. Nous ne garantissons aucun taux de disponibilité (« uptime ») contractuel.",
				"Les extraits audio dépendent du catalogue de Deezer : un morceau disponible aujourd'hui peut cesser de l'être demain si son ayant droit le retire du catalogue de Deezer, indépendamment de notre volonté. Un quiz peut donc voir certains de ses morceaux devenir temporairement ou définitivement indisponibles."
			]
		},
		{
			id: 'resiliation',
			heading: '6. Résiliation',
			paragraphs: [
				"Vous pouvez supprimer votre compte à tout moment depuis l'application (voir aussi notre politique de confidentialité pour le détail de ce qui est supprimé, anonymisé, ou conservé).",
				'Nous pouvons suspendre ou supprimer un compte qui enfreint de façon manifeste et répétée la section 3 (usage loyal), après un avertissement lorsque cela est raisonnablement possible.'
			]
		},
		{
			id: 'responsabilite',
			heading: '7. Limitation de responsabilité',
			paragraphs: [
				"Devinyl est un projet gratuit édité à titre non professionnel. Dans les limites autorisées par le droit français, notre responsabilité ne saurait être engagée pour les dommages indirects, la perte de données, ou l'indisponibilité temporaire du service ou du catalogue musical tiers dont il dépend. Rien dans les présentes CGU n'a pour objet d'exclure une responsabilité qui ne peut être légalement exclue (par exemple en cas de faute lourde ou intentionnelle)."
			]
		},
		{
			id: 'modifications',
			heading: '8. Modification des présentes CGU',
			paragraphs: [
				"Nous pouvons modifier ces CGU pour refléter une évolution du service, du catalogue musical tiers, ou de la réglementation. La date de dernière mise à jour en haut de page change à chaque révision ; en cas de changement substantiel, nous nous efforcerons de vous en informer par un moyen raisonnable (par exemple un message dans l'application). Poursuivre l'utilisation du service après une modification vaut acceptation des nouvelles CGU."
			]
		},
		{
			id: 'droit-applicable',
			heading: '9. Droit applicable',
			paragraphs: [
				"Les présentes CGU sont soumises au droit français. Tout litige qui ne pourrait être résolu à l'amiable relève, à défaut d'attribution légale impérative de compétence, des tribunaux français compétents."
			]
		}
	],
	contactLabel: '10. Contact',
	contactIntro: 'Pour toute question relative à ces CGU, écrivez-nous à :'
};

export const en: LegalContent = {
	documentTitle: 'Terms of Service',
	intro: [
		'These Terms of Service ("Terms") govern access to and use of Devinyl, a music blind-test game. By creating an account or playing, even as a guest, you accept these Terms.'
	],
	translationNote:
		'This document is written in, and legally governed by, its French version. This English text is provided as a courtesy translation; in case of any discrepancy, the French version prevails.',
	tocLabel: 'Contents',
	lastUpdatedLabel: 'Last updated',
	sections: [
		{
			id: 'service',
			heading: '1. Description of the service',
			paragraphs: [
				'Devinyl is a free game where you try to recognize a track from a 30-second audio preview. Audio previews come from the catalog of third-party provider Deezer, via its public API — Devinyl does not itself store or host the audio files, it streams them live from Deezer\'s servers. Those previews, and the recordings they are drawn from, remain the property of their respective rights holders (labels, artists, publishers). The service is provided "Powered by Deezer", a credit you will see displayed in the app. Devinyl is not published, operated by, or affiliated with Deezer.',
				'Devinyl also offers player-created quizzes, a daily quiz, leaderboards (overall, weekly, friends), and shareable challenge links.'
			]
		},
		{
			id: 'comptes',
			heading: '2. Accounts and minimum age',
			paragraphs: [
				'You can play without creating an account ("guest"), with history limited to the browser you used. Creating an account lets you save your progress, quizzes, and leaderboard standing durably.',
				'Creating an account is restricted to people aged 13 or older, based on a self-declaration made at signup. You are responsible for the accuracy of the information you provide and for keeping your password confidential.'
			]
		},
		{
			id: 'usage-loyal',
			heading: '3. Fair use of the service',
			paragraphs: ['By using Devinyl, you agree not to:'],
			list: [
				'Use scripts, bots, or any form of automation to play, guess, or otherwise falsify a score or leaderboard position;',
				'Bypass or attempt to bypass the server-side verification of answers and scores;',
				'Choose a display name, quiz title, or description that is abusive, obscene, discriminatory, impersonates a third party, or is otherwise unlawful;',
				"Attempt to access another account's data, or disrupt the service (deliberate overload, intrusion attempts)."
			]
		},
		{
			id: 'quiz-utilisateurs',
			heading: '4. User-created quizzes',
			paragraphs: [
				'If you create a quiz, you remain the owner of the titles and descriptions you write. By publishing them on Devinyl, you grant us a non-exclusive, royalty-free, worldwide licence to display them, distribute them via a shareable link, and surface them in the service (including to other players), for as long as the quiz exists.',
				'We reserve the right to remove, without prior notice, any quiz (or display name, or content) that violates these Terms or the law, in particular following a report.'
			]
		},
		{
			id: 'disponibilite',
			heading: '5. Service availability',
			paragraphs: [
				'Devinyl is a free service, provided "as is", with no guarantee of continuous availability or error-free operation. We make no contractual uptime commitment.',
				"Audio previews depend on Deezer's catalog: a track available today may stop being available tomorrow if its rights holder withdraws it from Deezer's catalog, independently of us. A quiz may therefore see some of its tracks become temporarily or permanently unavailable."
			]
		},
		{
			id: 'resiliation',
			heading: '6. Termination',
			paragraphs: [
				'You can delete your account at any time from within the app (see our privacy policy for the detail of what is deleted, anonymized, or retained).',
				'We may suspend or remove an account that clearly and repeatedly violates section 3 (fair use), with a warning where reasonably possible.'
			]
		},
		{
			id: 'responsabilite',
			heading: '7. Limitation of liability',
			paragraphs: [
				'Devinyl is a free project published on a non-professional basis. To the extent permitted by French law, we cannot be held liable for indirect damages, data loss, or the temporary unavailability of the service or of the third-party music catalog it depends on. Nothing in these Terms is intended to exclude any liability that cannot be lawfully excluded (for example, in case of gross or intentional misconduct).'
			]
		},
		{
			id: 'modifications',
			heading: '8. Changes to these Terms',
			paragraphs: [
				'We may update these Terms to reflect changes to the service, to the third-party music catalog, or to the law. The "last updated" date at the top of this page changes with every revision; for a substantial change, we will make a reasonable effort to let you know (for example, an in-app notice). Continuing to use the service after a change constitutes acceptance of the new Terms.'
			]
		},
		{
			id: 'droit-applicable',
			heading: '9. Governing law',
			paragraphs: [
				'These Terms are governed by French law. Any dispute that cannot be resolved amicably falls, absent any mandatory legal allocation of jurisdiction, under the competent French courts.'
			]
		}
	],
	contactLabel: '10. Contact',
	contactIntro: 'For any question about these Terms, write to us at:'
};
