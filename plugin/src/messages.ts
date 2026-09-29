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
  cellInsertionHint: 'Select empty cells, pick a label and type the text: the portion goes into the selected cells.',
  cellsOccupied: 'The selected cells hold a value, a merge or another portion: select empty cells.',
  cellBeingEdited: 'You are typing in a cell: press Enter or Esc to leave it, then try again.',
  labelLegend: 'Label',
  portionText: 'Portion text',
  insertButton: 'Insert protected portion',
  insertionFailed: 'The portion could not be inserted.',
  encryptionFailed: (reason: string): string => `The text could not be encrypted, so nothing was inserted (${reason}).`,
  changeButton: 'Change',
  saveChangeButton: 'Save the change',
  cancelButton: 'Cancel',
  deleteButton: 'Delete',
  deletionQuestion: 'Delete this portion? Its text leaves the document.',
  confirmDeletionButton: 'Delete the portion',
  deletionFailed: 'The portion could not be deleted.',
  beingChangedBy: (name: string): string => `Being changed by ${name}.`,
  changeRefused: 'Your clearance does not allow this portion’s label, so you cannot change or delete it.',
  lockFailed: (reason: string): string => `The portion could not be locked (${reason}).`,
  labelChoicesFailed: (reason: string): string => `The labels this portion may take could not be read (${reason}).`,
  lockLost: 'The portion’s lock was lost, so nothing was written.',
  portionChangedMeanwhile: 'This portion has just been changed: try again once the panel shows its new version.',
  changeFailed: 'The portion could not be changed.',
  changeEncryptionFailed: (reason: string): string => `The text could not be encrypted, so the portion is unchanged (${reason}).`,
  textTooLong: (limit: number): string => `A portion holds at most ${limit.toLocaleString('en')} characters.`,
  protectSelectionButton: 'Protect the selection',
  protectionQuestion: 'Protect this content under the label picked above? It becomes the text of a new portion, which takes its place.',
  protectionWarning:
    "The selected content already went through ONLYOFFICE in clear: it is protected from now on only, and copies made before, such as the editor's working files of this session, keep it.",
  protectionLabelMissing: 'Pick a label above to protect it.',
  selectionUnreadable: 'The selection could not be read.',
  cellsEmpty: "The selected cells are empty: type the portion's text and insert it.",
  selectionHoldsFormula: 'The selected cells hold a formula: turn it into its value first.',
  selectionHasSeveralAreas: 'The selection holds several blocks of cells: select one.',
  selectionHoldsMergePortionOrTable: 'The selected cells hold a merge, a portion, a table or a pivot table: select other cells.',
  cellsHoldComment: 'The selected cells hold a comment, which would stay in clear: delete it or select other cells.',
  selectionTooLarge: (limit: number): string => `The selection is too large: a portion holds at most ${limit.toLocaleString('en')} characters.`,
  selectionChanged: 'The selected content changed since the panel read it, so nothing was protected: protect it again.',
  selectionOutsideBody: 'Select paragraphs of the document itself, outside headers, footers, notes and shapes.',
  selectionHoldsTable: 'The selection holds a table: select paragraphs of text only.',
  selectionHoldsDrawing: 'The selection holds an image or a shape: select paragraphs of text only.',
  selectionHoldsContentControl: 'The selection holds part of a portion, a page marking or another content control: select other paragraphs.',
  paragraphsHoldComment: 'The selected paragraphs hold a comment, which would stay in clear: delete it or select other paragraphs.',
  paragraphsHoldNote: 'The selected paragraphs hold a footnote or an endnote, which would be lost: delete it or select other paragraphs.',
  paragraphsEmpty: "The selected paragraphs are empty: type the portion's text and insert it.",
  protectionFailed: 'The selection could not be protected.',
  protectionEncryptionFailed: (reason: string): string => `The content could not be encrypted, so nothing was protected (${reason}).`,
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
  protectionContextMenuEntry: 'Protect the selection',
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
  cellInsertionHint: 'Sélectionnez des cellules vides, choisissez une étiquette et saisissez le texte. La portion sera insérée dans les cellules sélectionnées.',
  cellsOccupied: 'Les cellules sélectionnées contiennent une valeur, une fusion ou une autre portion : sélectionnez des cellules vides.',
  cellBeingEdited: 'Vous êtes en train de saisir dans une cellule : appuyez sur Entrée ou Échap pour la quitter, puis réessayez.',
  labelLegend: 'Étiquette',
  portionText: 'Texte de la portion',
  insertButton: 'Insérer la portion protégée',
  insertionFailed: 'La portion n’a pas pu être insérée.',
  encryptionFailed: (reason: string): string => `Le texte n’a pas pu être chiffré, rien n’a donc été inséré (${reason}).`,
  changeButton: 'Modifier',
  saveChangeButton: 'Enregistrer la modification',
  cancelButton: 'Annuler',
  deleteButton: 'Supprimer',
  deletionQuestion: 'Supprimer cette portion ? Son texte quitte le document.',
  confirmDeletionButton: 'Supprimer la portion',
  deletionFailed: 'La portion n’a pas pu être supprimée.',
  beingChangedBy: (name: string): string => `En cours de modification par ${name}.`,
  changeRefused: 'Votre habilitation ne permet pas l’étiquette de cette portion : vous ne pouvez ni la modifier ni la supprimer.',
  lockFailed: (reason: string): string => `La portion n’a pas pu être verrouillée (${reason}).`,
  labelChoicesFailed: (reason: string): string => `Les étiquettes que peut prendre cette portion n’ont pas pu être lues (${reason}).`,
  lockLost: 'Le verrou de la portion a été perdu : rien n’a été écrit.',
  portionChangedMeanwhile: 'Cette portion vient d’être modifiée : réessayez quand le panneau montre sa nouvelle version.',
  changeFailed: 'La portion n’a pas pu être modifiée.',
  changeEncryptionFailed: (reason: string): string => `Le texte n’a pas pu être chiffré : la portion est inchangée (${reason}).`,
  textTooLong: (limit: number): string => `Une portion contient au plus ${limit.toLocaleString('fr')} caractères.`,
  protectSelectionButton: 'Protéger la sélection',
  protectionQuestion: 'Protéger ce contenu sous l’étiquette choisie ci-dessus ? Il devient le texte d’une nouvelle portion, qui prend sa place.',
  protectionWarning:
    'Le contenu sélectionné est déjà passé en clair par ONLYOFFICE : il n’est protégé qu’à partir de maintenant, et les copies faites avant, comme les fichiers de travail de l’éditeur pour cette session, le gardent.',
  protectionLabelMissing: 'Choisissez une étiquette ci-dessus pour le protéger.',
  selectionUnreadable: 'La sélection n’a pas pu être lue.',
  cellsEmpty: 'Les cellules sélectionnées sont vides : saisissez le texte de la portion et insérez-la.',
  selectionHoldsFormula: 'Les cellules sélectionnées contiennent une formule : remplacez-la d’abord par sa valeur.',
  selectionHasSeveralAreas: 'La sélection comporte plusieurs blocs de cellules : n’en sélectionnez qu’un.',
  selectionHoldsMergePortionOrTable:
    'Les cellules sélectionnées contiennent une fusion, une portion, un tableau ou un tableau croisé dynamique : sélectionnez d’autres cellules.',
  cellsHoldComment: 'Les cellules sélectionnées portent un commentaire, qui resterait en clair : supprimez-le ou sélectionnez d’autres cellules.',
  selectionTooLarge: (limit: number): string => `La sélection est trop grande : une portion contient au plus ${limit.toLocaleString('fr')} caractères.`,
  selectionChanged: 'Le contenu sélectionné a changé depuis que le panneau l’a lu : rien n’a été protégé. Protégez-le à nouveau.',
  selectionOutsideBody: 'Sélectionnez des paragraphes du document lui-même, hors des en-têtes, pieds de page, notes et formes.',
  selectionHoldsTable: 'La sélection contient un tableau : ne sélectionnez que des paragraphes de texte.',
  selectionHoldsDrawing: 'La sélection contient une image ou une forme : ne sélectionnez que des paragraphes de texte.',
  selectionHoldsContentControl:
    'La sélection contient une partie de portion, un marquage de page ou un autre contrôle de contenu : sélectionnez d’autres paragraphes.',
  paragraphsHoldComment: 'Les paragraphes sélectionnés portent un commentaire, qui resterait en clair : supprimez-le ou sélectionnez d’autres paragraphes.',
  paragraphsHoldNote: 'Les paragraphes sélectionnés contiennent une note de bas de page ou de fin, qui serait perdue : supprimez-la ou sélectionnez d’autres paragraphes.',
  paragraphsEmpty: 'Les paragraphes sélectionnés sont vides : saisissez le texte de la portion et insérez-la.',
  protectionFailed: 'La sélection n’a pas pu être protégée.',
  protectionEncryptionFailed: (reason: string): string => `Le contenu n’a pas pu être chiffré, rien n’a donc été protégé (${reason}).`,
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
  protectionContextMenuEntry: 'Protéger la sélection',
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
