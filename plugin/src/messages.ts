// Texts of the panel, of its entries in the editor's menus and of the blocks
// it writes, in the editor's language. Markings are not here: they come from
// the SPIF.

// The portal opens the editor in these languages only (EDITOR_LANGUAGES in
// portal/src/editor-config.ts): a new language goes into both.
export type Language = 'en' | 'fr';

const ENGLISH = {
  // Panel. The details in parentheses are technical messages, in English.
  connecting: 'Connecting…',
  unknownUser: 'Signed-in user unknown',
  rereadWarning: (problem: string): string => `The document could not be reread, so this panel may be out of date (${problem}).`,
  loadingPolicy: 'Loading the policy…',
  policyFailed: (reason: string): string => `The policy could not be loaded (${reason}).`,
  documentLabelTitle: 'Document label',
  baseLabel: 'Base label',
  newPortionTitle: 'New protected portion',
  allowedLabelsFailed: (reason: string): string => `The labels your clearance allows could not be loaded (${reason}).`,
  noAllowedLabel: 'Your clearance allows no label, so you cannot write protected portions.',
  insertionHint: 'Pick a label and type the text: the portion goes after the paragraph that holds the cursor.',
  labelLegend: 'Label',
  portionText: 'Portion text',
  insertButton: 'Insert protected portion',
  insertionFailed: 'The portion could not be inserted.',
  encryptionFailed: (reason: string): string => `The text could not be encrypted, so nothing was inserted (${reason}).`,
  changeButton: 'Change',
  saveChangeButton: 'Save the change',
  cancelButton: 'Cancel',
  beingChangedBy: (name: string): string => `Being changed by ${name}.`,
  changeRefused: 'Your clearance does not allow this portion’s label, so you cannot change it.',
  lockFailed: (reason: string): string => `The portion could not be locked for a change (${reason}).`,
  lockLost: 'The portion’s lock was lost, so the change was not saved.',
  portionChangedMeanwhile: 'This portion has just been changed: try again once the panel shows its new version.',
  changeFailed: 'The portion could not be changed.',
  changeEncryptionFailed: (reason: string): string => `The text could not be encrypted, so the portion is unchanged (${reason}).`,
  textTooLong: (limit: number): string => `A portion holds at most ${limit.toLocaleString('en')} characters.`,
  portionsTitle: 'Protected portions',
  bubbleTitle: 'Protected portion',
  noPortion: 'No protected portion yet.',
  portionTextUnavailable: 'Content not available in this document.',
  decrypting: 'Decrypting…',
  accessDenied: 'Access denied',
  couldNotDecrypt: (reason: string): string => `Could not decrypt (${reason}).`,
  notEncrypted: 'Not encrypted: this portion dates from before encryption.',
  labelMismatch: "The label in clear does not match the label bound to this portion's envelope, shown above.",
  boundLabelUnreadable: "The label bound to this portion's envelope cannot be read.",
  envelopeDamaged: 'the stored envelope is damaged',
  accessUndecided: 'the key service could not decide whether you may read it',
  noOpentdfPlatform: 'the editor configuration names no OpenTDF platform',
  // Editor menus
  contextMenuEntry: 'Insert protected portion',
  toolbarButton: 'Protected portion',
  toolbarButtonHint: 'Insert a protected portion',
  // Portion blocks, written into the document
  portionAlias: 'Protected portion',
  pageMarkingAlias: 'Page marking',
  portionPlaceholder: (marking: string): string => `${marking} – protected portion`,
};

export type Messages = typeof ENGLISH;

// Typed as the English set, so that no message is missing.
const FRENCH: Messages = {
  connecting: 'Connexion…',
  unknownUser: 'Utilisateur connecté inconnu',
  rereadWarning: (problem: string): string =>
    `Le document n’a pas pu être relu, ce panneau n’est donc peut-être plus à jour (${problem}).`,
  loadingPolicy: 'Chargement de la politique de sécurité…',
  policyFailed: (reason: string): string => `La politique de sécurité n’a pas pu être chargée (${reason}).`,
  documentLabelTitle: 'Étiquette du document',
  baseLabel: 'Étiquette de base',
  newPortionTitle: 'Nouvelle portion protégée',
  allowedLabelsFailed: (reason: string): string => `Les étiquettes que permet votre habilitation n’ont pas pu être chargées (${reason}).`,
  noAllowedLabel: 'Votre habilitation ne permet aucune étiquette, vous ne pouvez donc pas écrire de portion protégée.',
  insertionHint: 'Choisissez une étiquette et saisissez le texte. La portion sera insérée après le paragraphe où se trouve le curseur.',
  labelLegend: 'Étiquette',
  portionText: 'Texte de la portion',
  insertButton: 'Insérer la portion protégée',
  insertionFailed: 'La portion n’a pas pu être insérée.',
  encryptionFailed: (reason: string): string => `Le texte n’a pas pu être chiffré, rien n’a donc été inséré (${reason}).`,
  changeButton: 'Modifier',
  saveChangeButton: 'Enregistrer la modification',
  cancelButton: 'Annuler',
  beingChangedBy: (name: string): string => `En cours de modification par ${name}.`,
  changeRefused: 'Votre habilitation ne permet pas l’étiquette de cette portion : vous ne pouvez pas la modifier.',
  lockFailed: (reason: string): string => `La portion n’a pas pu être verrouillée pour une modification (${reason}).`,
  lockLost: 'Le verrou de la portion a été perdu : la modification n’a pas été enregistrée.',
  portionChangedMeanwhile: 'Cette portion vient d’être modifiée : réessayez quand le panneau montre sa nouvelle version.',
  changeFailed: 'La portion n’a pas pu être modifiée.',
  changeEncryptionFailed: (reason: string): string => `Le texte n’a pas pu être chiffré : la portion est inchangée (${reason}).`,
  textTooLong: (limit: number): string => `Une portion contient au plus ${limit.toLocaleString('fr')} caractères.`,
  portionsTitle: 'Portions protégées',
  bubbleTitle: 'Portion protégée',
  noPortion: 'Aucune portion protégée pour l’instant.',
  portionTextUnavailable: 'Contenu non disponible dans ce document.',
  decrypting: 'Déchiffrement…',
  accessDenied: 'Accès refusé',
  couldNotDecrypt: (reason: string): string => `Déchiffrement impossible (${reason}).`,
  notEncrypted: 'Non chiffrée. Cette portion date d’avant le chiffrement.',
  labelMismatch: 'L’étiquette en clair ne correspond pas à celle liée à l’enveloppe de cette portion, affichée ci-dessus.',
  boundLabelUnreadable: 'L’étiquette liée à l’enveloppe de cette portion est illisible.',
  envelopeDamaged: 'l’enveloppe enregistrée est abîmée',
  accessUndecided: 'le service de clés n’a pas pu décider si vous pouvez la lire',
  noOpentdfPlatform: 'la configuration de l’éditeur ne désigne aucune plateforme OpenTDF',
  contextMenuEntry: 'Insérer une portion protégée',
  toolbarButton: 'Portion protégée',
  toolbarButtonHint: 'Insérer une portion protégée',
  portionAlias: 'Portion protégée',
  pageMarkingAlias: 'Marquage de page',
  portionPlaceholder: (marking: string): string => `${marking} – portion protégée`,
};

const MESSAGES: Record<Language, Messages> = { en: ENGLISH, fr: FRENCH };

// The editor opens the panel's page with its own language in the `lang`
// query parameter, for example fr-FR. Any language but French gets English.
export const language: Language = languageOf(new URLSearchParams(window.location.search).get('lang'));

export const messages: Messages = MESSAGES[language];

function languageOf(tag: string | null): Language {
  const primary = tag?.split(/[-_]/)[0]?.toLowerCase();
  return primary === 'fr' ? 'fr' : 'en';
}
