import type { CommandScope, ControlSnapshot, DocumentSnapshot, HeaderFooterKind, HeaderFooterSnapshot, PortionBlockScope, PortionWriteScope } from './commands.ts';
import type {
  ApiBlockLvlSdt,
  ApiContentControl,
  ApiCustomXmlPart,
  ApiDocumentContent,
  ApiDocumentElement,
  ApiParagraph,
  ApiSection,
  HeaderFooterType,
  OfficeApi,
} from './office-api.ts';

// The commands the panel runs in the text editor. Each is serialised with
// toString() and runs in the editor's sandbox, where it may only use `Api`
// and `Asc.scope`.

declare const Api: OfficeApi;
declare const Asc: { scope: CommandScope };

// One command writes a new portion, a portion's change or its deletion, if
// there is one, with the document label and its page marking, so that a
// single undo reverts all of them. False when the portion to change or delete
// is gone.
export function writeLabellingCommand(): boolean {
  const scope = Asc.scope;
  const document = Api.GetDocument();
  const parts = document.GetCustomXmlParts();

  const isParagraph = (element: ApiDocumentElement | null): element is ApiParagraph => element?.GetClassType() === 'paragraph';
  const isBlock = (element: ApiDocumentElement | ApiContentControl | null): element is ApiBlockLvlSdt => element?.GetClassType() === 'blockLvlSdt';
  // The plugin's tags are JSON; other tools' tags may be anything.
  const parsedTag = (tag: string): unknown => {
    try {
      const parsed: unknown = JSON.parse(tag);
      return parsed;
    } catch (error: unknown) {
      if (error instanceof SyntaxError) {
        return null;
      }
      throw error;
    }
  };

  // A block of the plugin's own, locked only once `fill` has set its content.
  const lockedBlock = (tag: string, alias: string, fill: (paragraph: ApiParagraph | null, block: ApiBlockLvlSdt) => void): ApiBlockLvlSdt => {
    const block = Api.CreateBlockLvlSdt();
    block.SetTag(tag);
    block.SetAlias(alias);
    const first = block.GetContent().GetElement(0);
    fill(isParagraph(first) ? first : null, block);
    block.SetLock('sdtContentLocked');
    return block;
  };

  const showPortionLabel = (paragraph: ApiParagraph | null, control: ApiBlockLvlSdt, block: PortionBlockScope): void => {
    if (block.color !== null) {
      control.SetBorderColor(Api.HexColor(block.color));
    }
    paragraph?.RemoveAllElements();
    paragraph?.AddText(block.placeholder);
  };

  const insertPortionBlock = (portion: Extract<PortionWriteScope, { kind: 'insertion' }>): void => {
    const block = lockedBlock(portion.block.tag, portion.alias, (paragraph, control) => {
      showPortionLabel(paragraph, control, portion.block);
    });
    // Inserting at the cursor would split the paragraph that holds it. When
    // that paragraph has text and sits in the document body, the block goes
    // right after it; elsewhere (an empty paragraph, a table, a header) it
    // goes at the cursor, as the editor does.
    const paragraph = document.GetCurrentParagraph();
    const position = paragraph === null ? -1 : paragraph.GetPosInParent();
    const inBody = paragraph !== null && document.GetElement(position)?.GetInternalId() === paragraph.GetInternalId();
    if (inBody && paragraph.GetText().trim() !== '') {
      document.AddElement(position + 1, block);
    } else {
      document.InsertContent([block]);
    }
    parts.Add(portion.xml);
  };

  // A portion's part, found by the portion id its root element names, however
  // the editor serialises it, and its placeholder block, found by the portion
  // id in its tag; null unless the document holds both.
  const portionInDocument = (id: string): { portionParts: ApiCustomXmlPart[]; placeholders: ApiBlockLvlSdt[] } | null => {
    const portionParts = parts
      .GetByNamespace(scope.portionNamespace)
      .filter((part) => /<(?:[\w-]+:)?portion\b[^>]*?\sid=["']([^"']*)["']/.exec(part.GetXml())?.[1] === id);
    const placeholders = document.GetAllContentControls().filter((control): control is ApiBlockLvlSdt => {
      const tag = isBlock(control) ? parsedTag(control.GetTag()) : null;
      return typeof tag === 'object' && tag !== null && 'id' in tag && tag.id === id;
    });
    return portionParts.length === 0 || placeholders.length === 0 ? null : { portionParts, placeholders };
  };

  // The portion's part is replaced with its new version, and its placeholder
  // block shows its label.
  const changePortionBlock = (change: Extract<PortionWriteScope, { kind: 'change' }>): boolean => {
    const portion = portionInDocument(change.id);
    if (portion === null) {
      return false;
    }
    for (const part of portion.portionParts) {
      part.Delete();
    }
    parts.Add(change.xml);
    for (const control of portion.placeholders) {
      control.SetLock('unlocked');
      control.SetTag(change.block.tag);
      const first = control.GetContent().GetElement(0);
      showPortionLabel(isParagraph(first) ? first : null, control, change.block);
      control.SetLock('sdtContentLocked');
    }
    return true;
  };

  // The portion's placeholder block goes, unlocked first since the editor
  // refuses to delete a locked one, then its part. Should the editor refuse
  // all the same, the part stays and nothing counts as deleted.
  const deletePortionBlock = (deletion: Extract<PortionWriteScope, { kind: 'deletion' }>): boolean => {
    const portion = portionInDocument(deletion.id);
    if (portion === null) {
      return false;
    }
    const deleted = portion.placeholders.map((control) => {
      control.SetLock('unlocked');
      return control.Delete(false);
    });
    if (deleted.includes(false)) {
      return false;
    }
    for (const part of portion.portionParts) {
      part.Delete();
    }
    return true;
  };

  // The page marking is the first block of a header and the last of a
  // footer, where readDocumentCommand looks for it. The one this command
  // writes, already in place, locked and unchanged, stays, so that authors
  // writing the same one at once do not end up with two; any other goes.
  const marking = scope.pageMarking;
  const isPageMarking = (element: ApiDocumentElement | null): boolean => {
    const tag = isBlock(element) ? parsedTag(element.GetTag()) : null;
    return typeof tag === 'object' && tag !== null && 'kind' in tag && tag.kind === 'page-marking';
  };
  const isWrittenMarking = (element: ApiDocumentElement | null): boolean => {
    if (!isBlock(element) || element.GetTag() !== marking.tag || element.GetLock() !== 'sdtContentLocked') {
      return false;
    }
    const content = element.GetContent();
    const paragraph = content.GetElement(0);
    return content.GetElementsCount() === 1 && isParagraph(paragraph) && paragraph.GetText().trim() === marking.text;
  };
  const markPage = (content: ApiDocumentContent, kind: HeaderFooterKind, created: boolean): void => {
    const place = (): number => (kind === 'header' ? 0 : content.GetElementsCount() - 1);
    let kept = !created && isWrittenMarking(content.GetElement(place())) ? place() : -1;
    if (kept === -1) {
      const block = lockedBlock(marking.tag, marking.alias, (paragraph) => {
        paragraph?.SetJc('center');
        const text = paragraph?.AddText(marking.text);
        text?.SetBold(true);
        if (marking.color !== null) {
          text?.SetColor(Api.HexColor(marking.color));
        }
      });
      if (kind === 'header') {
        content.AddElement(0, block);
      } else {
        content.Push(block);
      }
      // A header or a footer comes with an empty paragraph.
      if (created) {
        content.RemoveElement(kind === 'header' ? 1 : 0);
      }
      kept = place();
    }
    for (let position = content.GetElementsCount() - 1; position >= 0; position -= 1) {
      if (position !== kept && isPageMarking(content.GetElement(position))) {
        content.RemoveElement(position);
      }
    }
  };
  const headerFooterOf = (section: ApiSection, type: HeaderFooterType, kind: HeaderFooterKind, create: boolean): ApiDocumentContent | null =>
    kind === 'header' ? section.GetHeader(type, create) : section.GetFooter(type, create);

  if (scope.portion?.kind === 'insertion') {
    insertPortionBlock(scope.portion);
  }
  if (scope.portion?.kind === 'change' && !changePortionBlock(scope.portion)) {
    return false;
  }
  if (scope.portion?.kind === 'deletion' && !deletePortionBlock(scope.portion)) {
    return false;
  }
  for (const replacement of scope.replacements) {
    for (const existing of parts.GetByNamespace(replacement.namespace)) {
      existing.Delete();
    }
    parts.Add(replacement.xml);
  }
  // Every kind of header and footer: the default ones, the first page's and
  // the even pages'. A later section without one of its own shows the
  // previous section's, so only the first section gets the missing ones.
  for (const [index, section] of document.GetSections().entries()) {
    for (const type of ['default', 'title', 'even'] as const) {
      for (const kind of ['header', 'footer'] as const) {
        const own = headerFooterOf(section, type, kind, false);
        const content = own ?? (index === 0 ? headerFooterOf(section, type, kind, true) : null);
        if (content !== null) {
          markPage(content, kind, own === null);
        }
      }
    }
  }
  return true;
}

export function readDocumentCommand(): DocumentSnapshot {
  const document = Api.GetDocument();
  const parts = document.GetCustomXmlParts();
  const isParagraph = (element: ApiDocumentElement | null): element is ApiParagraph => element?.GetClassType() === 'paragraph';
  const isBlock = (element: ApiDocumentElement | null): element is ApiBlockLvlSdt => element?.GetClassType() === 'blockLvlSdt';
  const controlOf = (element: ApiDocumentElement | null): ControlSnapshot | null => {
    if (!isBlock(element)) {
      return null;
    }
    const content = element.GetContent();
    const paragraph = content.GetElement(0);
    const text = content.GetElementsCount() === 1 && isParagraph(paragraph) ? paragraph.GetText().trim() : null;
    return { tag: element.GetTag(), lock: element.GetLock(), text };
  };
  // The headers and footers the page marking must be in, as
  // writeLabellingCommand finds them.
  const headersAndFooters: HeaderFooterSnapshot[] = [];
  for (const [index, section] of document.GetSections().entries()) {
    for (const type of ['default', 'title', 'even'] as const) {
      for (const kind of ['header', 'footer'] as const) {
        const content = kind === 'header' ? section.GetHeader(type, false) : section.GetFooter(type, false);
        if (content === null && index > 0) {
          continue;
        }
        const blocks: (ControlSnapshot | null)[] = [];
        for (let position = 0; content !== null && position < content.GetElementsCount(); position += 1) {
          blocks.push(controlOf(content.GetElement(position)));
        }
        headersAndFooters.push({ kind, blocks: content === null ? null : blocks });
      }
    }
  }
  return {
    controls: document.GetAllContentControls().map((control) => ({
      tag: control.GetTag(),
      internalId: control.GetInternalId(),
    })),
    portionParts: parts.GetByNamespace(Asc.scope.portionNamespace).map((part) => part.GetXml()),
    documentParts: parts.GetByNamespace(Asc.scope.documentNamespace).map((part) => part.GetXml()),
    headersAndFooters,
  };
}
