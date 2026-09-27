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
  insertionHint: 'Pick a label and type the text: the portion goes after the paragraph that holds the cursor.',
  labelLegend: 'Label',
  portionText: 'Portion text',
  insertButton: 'Insert protected portion',
  insertionFailed: 'The portion could not be inserted.',
  portionsTitle: 'Protected portions',
  noPortion: 'No protected portion yet.',
  portionTextUnavailable: 'Content not available in this document.',
  // Editor menus
  contextMenuEntry: 'Insert protected portion',
  toolbarButton: 'Protected portion',
  toolbarButtonHint: 'Insert a protected portion',
  // Portion blocks, written into the document
  portionAlias: 'Protected portion',
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
  insertionHint: 'Choisissez une étiquette et saisissez le texte. La portion sera insérée après le paragraphe où se trouve le curseur.',
  labelLegend: 'Étiquette',
  portionText: 'Texte de la portion',
  insertButton: 'Insérer la portion protégée',
  insertionFailed: 'La portion n’a pas pu être insérée.',
  portionsTitle: 'Portions protégées',
  noPortion: 'Aucune portion protégée pour l’instant.',
  portionTextUnavailable: 'Contenu non disponible dans ce document.',
  contextMenuEntry: 'Insérer une portion protégée',
  toolbarButton: 'Portion protégée',
  toolbarButtonHint: 'Insérer une portion protégée',
  portionAlias: 'Portion protégée',
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
