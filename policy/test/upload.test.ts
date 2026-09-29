import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DOMParser, type Element } from '@xmldom/xmldom';
import type { FastifyInstance } from 'fastify';
import JSZip from 'jszip';
import { buildPolicyServer } from '../src/server.ts';
import { verifyWithXmlsec } from './xmlsec.ts';

const DEMO_SPIFS = path.join(import.meta.dirname, '..', '..', 'deploy', 'spif');
const DEMO_LABEL_MAPPING = path.join(DEMO_SPIFS, 'demo-fr.label-mapping.json');
const TEMPLATE = path.join(import.meta.dirname, '..', '..', 'deploy', 'demo', 'documents', 'exercise-northwind.docx');
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SECRET = 'fictional-binding-signature-secret';
const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const DOCUMENT_NAMESPACE = 'urn:linagora:dcs:document:1';
const PORTION_NAMESPACE = 'urn:linagora:dcs:portion:1';
const SPREADSHEET_NAMESPACE = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
// The extension in which ONLYOFFICE writes a sheet's user protected ranges.
const USER_PROTECTED_RANGES_EXTENSION = '{231B7EB2-2AFC-4442-B178-5FFDF5851E7C}';
const BINDING_NAMESPACE = 'urn:nato:stanag:4778:bindinginformation:1:0';
const LABEL_NAMESPACE = 'urn:nato:stanag:4774:confidentialitymetadatalabel:1:0';
const CUSTOM_XML_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml';
const CUSTOM_XML_PROPERTIES_TYPE = 'application/vnd.openxmlformats-officedocument.customXmlProperties+xml';
// The first bytes of an OLE compound file ([MS-CFB] §2.2), as an encrypted
// Office document is one ([MS-OFFCRYPTO] §1.3.3.4).
const COMPOUND_FILE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const DIFFUSION_RESTREINTE = 'DEMO-FR:2';
const SPECIAL_FRANCE = 'DEMO-FR:2/1.1';

// A compound file whose directory names the given streams, as UTF-16 names.
function compoundFile(streams: string[]): Uint8Array {
  return Buffer.concat([COMPOUND_FILE_SIGNATURE, Buffer.alloc(504), ...streams.map((name) => Buffer.from(`${name}\0`, 'utf16le'))]);
}

// The smallest WordprocessingML package: a main document part, without the
// relationships part, styles, notes or document properties that Word and
// ONLYOFFICE add, whose body holds the given content controls' tags.
async function minimalDocx(tags: string[] = [], customXml: string[] = []): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  const controls = tags.map((tag) => `<w:sdt><w:sdtPr><w:tag w:val="${tag.replaceAll('"', '&quot;')}"/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>Fictional placeholder</w:t></w:r></w:p></w:sdtContent></w:sdt>`);
  zip.file('word/document.xml', `<w:document xmlns:w="${WORD_NAMESPACE}"><w:body>${controls.join('')}<w:p><w:r><w:t>Fictional text in clear</w:t></w:r></w:p></w:body></w:document>`);
  customXml.forEach((xml, index) => zip.file(`customXml/item${index + 1}.xml`, xml));
  return zip.generateAsync({ type: 'uint8array' });
}

// The smallest SpreadsheetML package: a workbook part and one worksheet,
// without the styles, shared strings or document properties that Excel and
// ONLYOFFICE add. Each portion has its part and, as the platform writes it, a
// user protected range titled with its id.
async function minimalXlsx(portions: { id: string; label: string }[] = [], customXml: string[] = []): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  );
  zip.file(
    'xl/workbook.xml',
    `<workbook xmlns="${SPREADSHEET_NAMESPACE}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Fictional" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  const ranges = portions.map(({ id }, index) => `<userProtectedRange name="${id}" sqref="F${4 + 2 * index}:G${4 + 2 * index}"/>`).join('');
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<worksheet xmlns="${SPREADSHEET_NAMESPACE}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Fictional text in clear</t></is></c></row></sheetData>` +
      (portions.length === 0 ? '' : `<extLst><ext uri="${USER_PROTECTED_RANGES_EXTENSION}"><userProtectedRanges>${ranges}</userProtectedRanges></ext></extLst>`) +
      '</worksheet>',
  );
  const portionParts = portions.map(({ id, label }) => `<dcs:portion xmlns:dcs="${PORTION_NAMESPACE}" id="${id}" version="1" label="${label}"/>`);
  [...portionParts, ...customXml].forEach((xml, index) => zip.file(`customXml/item${index + 1}.xml`, xml));
  return zip.generateAsync({ type: 'uint8array' });
}

// The demo policy's identifier, as its labels name it.
const DEMO_POLICY_URI = 'urn:oid:2.25.166231019600111174217682845337071458325';

// An ADatP-4774 originator label, as another labelling tool could write it.
function originatorLabel(policy: string, uri: string, classification: string, categories = ''): string {
  return (
    `<slab:originatorConfidentialityLabel xmlns:slab="${LABEL_NAMESPACE}"><slab:ConfidentialityInformation>` +
    `<slab:PolicyIdentifier URI="${uri}">${policy}</slab:PolicyIdentifier><slab:Classification>${classification}</slab:Classification>${categories}` +
    '</slab:ConfidentialityInformation></slab:originatorConfidentialityLabel>'
  );
}

// An ADatP-4778.2 binding of a document label to the main document part,
// unsigned, as another labelling tool could write it.
function bindingOf(labelXml: string): string {
  return (
    `<mb:BindingInformation xmlns:mb="${BINDING_NAMESPACE}"><mb:MetadataBindingContainer><mb:MetadataBinding Id="mb-document">` +
    `<mb:Metadata>${labelXml}</mb:Metadata><mb:DataReference URI="pack:///word/document.xml"/>` +
    '</mb:MetadataBinding></mb:MetadataBindingContainer></mb:BindingInformation>'
  );
}

// A package with one more Custom XML part, of the given name, related from
// the main document as ECMA-376 Part 1 §15.2.5 requires.
async function withRelatedCustomXml(docx: Uint8Array, part: string, xml: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(docx);
  zip.file(part, xml);
  const relationships = (await zip.file('word/_rels/document.xml.rels')?.async('string')) ?? '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  zip.file('word/_rels/document.xml.rels', relationships.replace('</Relationships>', `<Relationship Id="rIdLabels" Type="${CUSTOM_XML_RELATIONSHIP}" Target="../${part}"/></Relationships>`));
  return zip.generateAsync({ type: 'uint8array' });
}

// The XML of a package's Custom XML parts, by part name.
async function customXmlTexts(zip: JSZip): Promise<Map<string, string>> {
  const parts = new Map<string, string>();
  for (const name of Object.keys(zip.files).filter((file) => /^customXml\/item\d+\.xml$/.test(file))) {
    parts.set(name, (await zip.file(name)?.async('string')) ?? '');
  }
  return parts;
}

// The example label mapping's fictional tenant and sensitivity labels
// (deploy/spif), and another tenant.
const DEMO_TENANT = '00000000-0000-0000-0000-000000000000';
const OTHER_TENANT = '11111111-2222-3333-4444-555555555555';
const SENSITIVITY_LABELS = { diffusionRestreinte: '10000000-0000-4000-8000-000000000002', nato: '10000000-0000-4000-8000-000000000003' } as const;
const LABEL_LIST_NAMESPACE = 'http://schemas.microsoft.com/office/2020/mipLabelMetadata';
const LABEL_INFORMATION_RELATIONSHIP = 'http://schemas.microsoft.com/office/2020/02/relationships/classificationlabels';
// When Word set a label, in the format of [MS-OI29500] §3.11.2.
const WORD_SET_DATE = '2018-09-24T21:38:47-0800';

// A tenant's label properties, as [MS-OI29500] §3.11.2 shows Word writing them.
function wordLabelProperties(labelId: string, tenant: string, firstPid: number, options: { enabled?: string; actionId?: string } = {}): string {
  const values = [
    ['Enabled', options.enabled ?? 'true'],
    ['SetDate', WORD_SET_DATE],
    ['Method', 'Standard'],
    ['Name', 'Fictional label'],
    ['SiteId', tenant],
    ['ActionId', options.actionId ?? randomUUID()],
    ['ContentBits', '0'],
  ];
  return values
    .map(([attribute, value], index) => `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${firstPid + index}" name="MSIP_Label_${labelId}_${attribute}"><vt:lpwstr>${value}</vt:lpwstr></property>`)
    .join('');
}

// A Sensitivity Label Information element, as the examples of
// [MS-OFFCRYPTO] §3.12 write it, ids braced; a removed one as they write it.
function wordLabelElement(labelId: string, tenant: string, removed = false): string {
  return removed
    ? `<clbl:label id="{${tenant}}" enabled="0" method="" siteId="{${tenant}}" removed="1" />`
    : `<clbl:label id="{${labelId}}" enabled="1" method="Privileged" siteId="{${tenant}}" contentBits="0" removed="0" />`;
}

// A package with custom properties, or a Sensitivity Label Information part,
// or both, each with its relationship and content type, as Word writes them.
async function withLabelMetadata(file: Uint8Array, metadata: { properties: string | null; labelList: string | null }): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(file);
  let relationships = (await zip.file('_rels/.rels')?.async('string')) ?? '';
  let types = (await zip.file('[Content_Types].xml')?.async('string')) ?? '';
  if (metadata.properties !== null) {
    zip.file('docProps/custom.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">${metadata.properties}</Properties>`);
    relationships = relationships.replace('</Relationships>', '<Relationship Id="rIdCustom" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>');
    types = types.replace('</Types>', '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>');
  }
  if (metadata.labelList !== null) {
    zip.file('docMetadata/LabelInfo.xml', `<?xml version="1.0" encoding="utf-8" standalone="yes"?><clbl:labelList xmlns:clbl="${LABEL_LIST_NAMESPACE}">${metadata.labelList}</clbl:labelList>`);
    relationships = relationships.replace('</Relationships>', `<Relationship Id="rIdLabels" Type="${LABEL_INFORMATION_RELATIONSHIP}" Target="docMetadata/LabelInfo.xml"/></Relationships>`);
    types = types.replace('</Types>', '<Override PartName="/docMetadata/LabelInfo.xml" ContentType="application/vnd.ms-office.classificationlabels+xml"/></Types>');
  }
  zip.file('_rels/.rels', relationships);
  zip.file('[Content_Types].xml', types);
  return zip.generateAsync({ type: 'uint8array' });
}

// The reason a refusal gives, undefined for another answer.
function reasonOf(json: unknown): unknown {
  return typeof json === 'object' && json !== null && 'reason' in json ? json.reason : undefined;
}

describe('uploads', () => {
  let server: FastifyInstance;
  let keys = '';
  let certificate = '';

  before(async () => {
    keys = await mkdtemp(path.join(tmpdir(), 'upload-keys-'));
    execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', path.join(keys, 'signer.key')]);
    execFileSync('openssl', ['req', '-new', '-x509', '-key', path.join(keys, 'signer.key'), '-out', path.join(keys, 'signer.pem'), '-days', '30', '-subj', '/CN=Fictional signer']);
    certificate = await readFile(path.join(keys, 'signer.pem'), 'utf8');
    server = await buildPolicyServer({
      spifDirectory: DEMO_SPIFS,
      labelMappingFile: DEMO_LABEL_MAPPING,
      bindingSignature: { secret: SECRET, signer: { privateKey: await readFile(path.join(keys, 'signer.key'), 'utf8'), certificate } },
      now: () => new Date('2026-09-29T08:00:00.000Z'),
    });
  });
  after(async () => {
    await server.close();
    await rm(keys, { recursive: true, force: true });
  });

  // The package the preparation answers, of the type it was sent as, or the
  // refusal it answers.
  async function preparedPackage(body: Uint8Array, query: string, type: string, secret: string | null): Promise<{ statusCode: number; json: unknown; file: Uint8Array | null }> {
    const response = await server.inject({
      method: 'POST',
      url: `/uploads/prepare${query}`,
      headers: { 'content-type': type, ...(secret === null ? {} : { authorization: `Bearer ${secret}` }) },
      payload: Buffer.from(body),
    });
    const isPackage = response.headers['content-type'] === type;
    return { statusCode: response.statusCode, json: isPackage ? null : response.json(), file: isPackage ? new Uint8Array(response.rawPayload) : null };
  }

  async function prepared(body: Uint8Array, query: string, secret: string | null = SECRET): Promise<{ statusCode: number; json: unknown; docx: Uint8Array | null }> {
    const { file, ...answer } = await preparedPackage(body, query, DOCX_TYPE, secret);
    return { ...answer, docx: file };
  }

  async function preparedWorkbook(body: Uint8Array, query: string): Promise<{ statusCode: number; json: unknown; xlsx: Uint8Array | null }> {
    const { file, ...answer } = await preparedPackage(body, query, XLSX_TYPE, SECRET);
    return { ...answer, xlsx: file };
  }

  async function read(body: Uint8Array, type = DOCX_TYPE): Promise<{ statusCode: number; json: unknown }> {
    const response = await server.inject({
      method: 'POST',
      url: '/uploads/read',
      headers: { 'content-type': type, authorization: `Bearer ${SECRET}` },
      payload: Buffer.from(body),
    });
    return { statusCode: response.statusCode, json: response.json() };
  }

  function base(code: string): string {
    return `?base=${encodeURIComponent(code)}`;
  }

  // The package as the portal stores it once the signing route has signed it.
  async function signedAndStored(file: Uint8Array, type = DOCX_TYPE): Promise<{ stored: Uint8Array; bindingXml: string }> {
    const response = await server.inject({
      method: 'POST',
      url: '/bindings/sign',
      headers: { 'content-type': type, authorization: `Bearer ${SECRET}` },
      payload: Buffer.from(file),
    });
    assert.equal(response.statusCode, 200);
    const answer: unknown = response.json();
    const written = typeof answer === 'object' && answer !== null && 'signed' in answer && 'parts' in answer ? [answer.signed, ...(Array.isArray(answer.parts) ? answer.parts : [])] : [];
    const zip = await JSZip.loadAsync(file);
    let bindingXml = '';
    for (const part of written) {
      const name: unknown = typeof part === 'object' && part !== null && 'part' in part ? part.part : null;
      const xml: unknown = typeof part === 'object' && part !== null && 'xml' in part ? part.xml : null;
      assert.ok(typeof name === 'string' && typeof xml === 'string');
      zip.file(name, xml);
      if (xml.includes(BINDING_NAMESPACE)) {
        bindingXml = xml;
      }
    }
    return { stored: await zip.generateAsync({ type: 'uint8array' }), bindingXml };
  }

  // The Custom XML parts of a package, by the namespace of their root.
  async function customXmlParts(docx: Uint8Array): Promise<Map<string, { part: string; root: Element }>> {
    const zip = await JSZip.loadAsync(docx);
    const parts = new Map<string, { part: string; root: Element }>();
    for (const part of Object.keys(zip.files).filter((name) => /^customXml\/item\d+\.xml$/.test(name))) {
      const root = new DOMParser().parseFromString((await zip.file(part)?.async('string')) ?? '', 'text/xml').documentElement;
      if (root !== null) {
        parts.set(root.namespaceURI ?? '', { part, root });
      }
    }
    return parts;
  }

  describe('the preparation of an uploaded document', () => {
    for (const [kind, body, reason] of [
      ['a file that is no ZIP package', new TextEncoder().encode('Not a document at all'), 'not-a-package'],
      ['a file that Purview encrypted', compoundFile(['\u0006DataSpaces', 'DRMEncryptedDataSpace', 'EncryptedPackage']), 'rights-management'],
      ['a file that a password protects', compoundFile(['EncryptionInfo', 'EncryptedPackage']), 'password'],
      ['another compound file, such as a legacy .doc', compoundFile(['WordDocument']), 'compound-file'],
    ] as const) {
      it(`refuses ${kind}, and says so`, async () => {
        const { statusCode, json } = await prepared(body, base(DIFFUSION_RESTREINTE));

        assert.equal(statusCode, 422);
        assert.equal(reasonOf(json), reason);
      });
    }

    it('refuses a ZIP package whose main part is neither a Word document nor a workbook, and names both', async () => {
      const zip = new JSZip();
      zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="txt" ContentType="text/plain"/></Types>');
      zip.file('notes.txt', 'Fictional notes');

      const { statusCode, json } = await prepared(await zip.generateAsync({ type: 'uint8array' }), base(DIFFUSION_RESTREINTE));

      assert.equal(statusCode, 422);
      assert.deepEqual(json, { error: 'The package holds no Word document or workbook', reason: 'not-a-document' });
    });

    it('refuses a base label that the security policy does not know', async () => {
      const { statusCode, json } = await prepared(await minimalDocx(), base('DEMO-FR:7'));

      assert.equal(statusCode, 422);
      assert.equal(reasonOf(json), 'unknown-label');
    });

    for (const [kind, query] of [
      ['no base label', ''],
      ['two base labels', `${base(DIFFUSION_RESTREINTE)}&base=${encodeURIComponent(DIFFUSION_RESTREINTE)}`],
    ] as const) {
      it(`refuses a request with ${kind}`, async () => {
        const { statusCode } = await prepared(await minimalDocx(), query);

        assert.equal(statusCode, 400);
      });
    }

    it('refuses a file whose portion labels in clear designate no label', async () => {
      const { statusCode, json } = await prepared(await minimalDocx(['{"id":"p1","label":"DEMO-FR:9"}']), base(DIFFUSION_RESTREINTE));

      assert.equal(statusCode, 422);
      assert.equal(reasonOf(json), 'portion-labels');
    });

    it('refuses a file with several document label bindings, which the signature could not replace', async () => {
      const binding = `<mb:BindingInformation xmlns:mb="${BINDING_NAMESPACE}"/>`;

      const { statusCode, json } = await prepared(await minimalDocx([], [binding, binding]), base(DIFFUSION_RESTREINTE));

      assert.equal(statusCode, 422);
      assert.equal(reasonOf(json), 'several-bindings');
    });

    it('refuses a file whose document label binding is not well-formed XML', async () => {
      const { statusCode, json } = await prepared(await minimalDocx([], [`<mb:BindingInformation xmlns:mb="${BINDING_NAMESPACE}">`]), base(DIFFUSION_RESTREINTE));

      assert.equal(statusCode, 422);
      assert.equal(reasonOf(json), 'malformed-binding');
    });

    it('refuses a caller without the secret it shares with the portal', async () => {
      const { statusCode } = await prepared(await minimalDocx(), base(DIFFUSION_RESTREINTE), null);

      assert.equal(statusCode, 403);
    });

    it('writes the base label part and the binding of an unlabelled DOCX, as the panel writes them', async () => {
      const { statusCode, docx } = await prepared(new Uint8Array(await readFile(TEMPLATE)), base(DIFFUSION_RESTREINTE));

      assert.equal(statusCode, 200);
      assert.ok(docx !== null);
      const parts = await customXmlParts(docx);
      const baseLabel = parts.get(DOCUMENT_NAMESPACE);
      assert.deepEqual([baseLabel?.root.getAttribute('base'), baseLabel?.root.getAttribute('label')], [DIFFUSION_RESTREINTE, DIFFUSION_RESTREINTE]);
      assert.ok(parts.has(BINDING_NAMESPACE));
      // Each part is a Custom XML part of the main document, with its properties.
      const zip = await JSZip.loadAsync(docx);
      const elements = async (part: string, localName: string): Promise<Element[]> =>
        Array.from(new DOMParser().parseFromString((await zip.file(part)?.async('string')) ?? '<none/>', 'text/xml').getElementsByTagName(localName));
      const documentRelationships = await elements('word/_rels/document.xml.rels', 'Relationship');
      const overrides = await elements('[Content_Types].xml', 'Override');
      for (const { part } of parts.values()) {
        const item = path.basename(part);
        const properties = `customXml/${item.replace('item', 'itemProps')}`;
        assert.ok(documentRelationships.some((relationship) => relationship.getAttribute('Type') === CUSTOM_XML_RELATIONSHIP && relationship.getAttribute('Target') === `../customXml/${item}`));
        assert.deepEqual((await elements(`customXml/_rels/${item}.rels`, 'Relationship')).map((relationship) => relationship.getAttribute('Target')), [path.basename(properties)]);
        assert.match((await zip.file(properties)?.async('string')) ?? '', /ds:itemID="\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}"/);
        assert.deepEqual(overrides.filter((override) => override.getAttribute('PartName') === `/${properties}`).map((override) => override.getAttribute('ContentType')), [CUSTOM_XML_PROPERTIES_TYPE]);
      }
    });

    it('prepares a package that signs as it is, over the parts it holds, with the document label its portions give', async () => {
      // A DIFFUSION RESTREINTE document with a SPECIAL FRANCE portion, in a
      // package without notes, headers, styles or document properties.
      const { docx } = await prepared(await minimalDocx([JSON.stringify({ id: 'p1', label: SPECIAL_FRANCE })]), base(DIFFUSION_RESTREINTE));
      assert.ok(docx !== null);

      const { stored, bindingXml } = await signedAndStored(docx);

      const verification = await verifyWithXmlsec(stored, bindingXml, certificate);
      assert.equal(verification.status, 0);
      // The document itself, and the custom properties the sensitivity label
      // went to.
      assert.deepEqual([...verification.references].sort(), ['docProps/custom.xml', 'word/document.xml']);
      assert.equal(verification.manifest, '2/2');
      // The demo policy's rule adds the informative category MORE RESTRICTIVE
      // PORTIONS to a base label below one of the portions.
      const label = new DOMParser().parseFromString(bindingXml, 'text/xml');
      assert.deepEqual(
        Array.from(label.getElementsByTagNameNS(LABEL_NAMESPACE, 'Classification')).map((element) => element.textContent),
        ['DIFFUSION RESTREINTE'],
      );
      assert.deepEqual(
        Array.from(label.getElementsByTagNameNS(LABEL_NAMESPACE, 'Category')).map((category) => [category.getAttribute('Type'), category.getAttribute('TagName'), category.textContent?.trim()]),
        [['INFORMATIVE', 'Composition', 'MORE RESTRICTIVE PORTIONS']],
      );
      const custom = (await (await JSZip.loadAsync(stored)).file('docProps/custom.xml')?.async('string')) ?? '';
      assert.match(custom, /MSIP_Label_10000000-0000-4000-8000-000000000002_Enabled/);
    });

    it('replaces a binding in whichever Custom XML part holds it', async () => {
      const docx = await withRelatedCustomXml(await minimalDocx(), 'customXml/labels.xml', bindingOf(originatorLabel('DEMO-FR', DEMO_POLICY_URI, 'DIFFUSION RESTREINTE')));

      const { docx: preparedDocx } = await prepared(docx, base(DIFFUSION_RESTREINTE));

      assert.ok(preparedDocx !== null);
      const zip = await JSZip.loadAsync(preparedDocx);
      const bindings = [];
      for (const name of Object.keys(zip.files).filter((file) => file.startsWith('customXml/') && !file.includes('_rels') && !file.includes('itemProps'))) {
        if (((await zip.file(name)?.async('string')) ?? '').includes(BINDING_NAMESPACE)) {
          bindings.push(name);
        }
      }
      assert.deepEqual(bindings, ['customXml/labels.xml']);
    });
  });

  describe('the upload of a workbook', () => {
    it('prepares a workbook whose base label part and binding, related from its workbook part, sign as they are', async () => {
      const { statusCode, xlsx } = await preparedWorkbook(await minimalXlsx(), base(DIFFUSION_RESTREINTE));

      assert.equal(statusCode, 200);
      assert.ok(xlsx !== null);
      const parts = await customXmlParts(xlsx);
      const baseLabel = parts.get(DOCUMENT_NAMESPACE);
      assert.deepEqual([baseLabel?.root.getAttribute('base'), baseLabel?.root.getAttribute('label')], [DIFFUSION_RESTREINTE, DIFFUSION_RESTREINTE]);
      const zip = await JSZip.loadAsync(xlsx);
      const relationships = new DOMParser().parseFromString((await zip.file('xl/_rels/workbook.xml.rels')?.async('string')) ?? '<none/>', 'text/xml');
      const related = Array.from(relationships.getElementsByTagName('Relationship'))
        .filter((relationship) => relationship.getAttribute('Type') === CUSTOM_XML_RELATIONSHIP)
        .map((relationship) => relationship.getAttribute('Target'));
      assert.deepEqual(related.sort(), [...parts.values()].map(({ part }) => `../${part}`).sort());

      const { stored, bindingXml } = await signedAndStored(xlsx, XLSX_TYPE);

      const verification = await verifyWithXmlsec(stored, bindingXml, certificate);
      assert.equal(verification.status, 0);
      assert.deepEqual([...verification.references].sort(), ['docProps/custom.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
    });

    it('reads the base label the platform wrote into a workbook, and a binding signature that matches', async () => {
      const { xlsx } = await preparedWorkbook(await minimalXlsx(), base('DEMO-FR:2/2.1'));
      assert.ok(xlsx !== null);
      const { stored } = await signedAndStored(xlsx, XLSX_TYPE);

      assert.deepEqual(await read(stored, XLSX_TYPE), { statusCode: 200, json: { label: { code: 'DEMO-FR:2/2.1', source: 'base-label' }, signature: 'matched' } });
    });

    it('reads the document label of a binding another tool wrote into a workbook', async () => {
      const xlsx = await minimalXlsx([], [bindingOf(originatorLabel('DEMO-FR', DEMO_POLICY_URI, 'DIFFUSION RESTREINTE'))]);

      assert.deepEqual(await read(xlsx, XLSX_TYPE), { statusCode: 200, json: { label: { code: DIFFUSION_RESTREINTE, source: 'binding' }, signature: 'absent' } });
    });

    it("reads the mapped tenant's label from a workbook's custom properties", async () => {
      const xlsx = await withLabelMetadata(await minimalXlsx(), { properties: wordLabelProperties(SENSITIVITY_LABELS.diffusionRestreinte, DEMO_TENANT, 2), labelList: null });

      assert.deepEqual(await read(xlsx, XLSX_TYPE), { statusCode: 200, json: { label: { code: DIFFUSION_RESTREINTE, source: 'sensitivity-label' }, signature: 'absent' } });
    });

    it("keeps a workbook's portions, whose labels count in its document label", async () => {
      const { xlsx } = await preparedWorkbook(await minimalXlsx([{ id: 'p1', label: SPECIAL_FRANCE }]), base(DIFFUSION_RESTREINTE));

      assert.ok(xlsx !== null);
      const parts = await customXmlParts(xlsx);
      assert.deepEqual([parts.get(PORTION_NAMESPACE)?.root.getAttribute('id'), parts.get(PORTION_NAMESPACE)?.root.getAttribute('label')], ['p1', SPECIAL_FRANCE]);
      // The demo policy's rule adds the informative category MORE RESTRICTIVE
      // PORTIONS to a base label below one of the portions.
      assert.equal(parts.get(DOCUMENT_NAMESPACE)?.root.getAttribute('label'), 'DEMO-FR:2/3.1');
      const sheet = (await (await JSZip.loadAsync(xlsx)).file('xl/worksheets/sheet1.xml')?.async('string')) ?? '';
      assert.match(sheet, /<userProtectedRange name="p1" sqref="F4:G4"\/>/);
    });

    it('prepares a workbook that Microsoft 365 labelled without its Sensitivity Label Information part', async () => {
      const xlsx = await withLabelMetadata(await minimalXlsx(), {
        properties: wordLabelProperties(SENSITIVITY_LABELS.diffusionRestreinte, DEMO_TENANT, 2),
        labelList: wordLabelElement(SENSITIVITY_LABELS.diffusionRestreinte, DEMO_TENANT),
      });
      assert.deepEqual(await read(xlsx, XLSX_TYPE), { statusCode: 200, json: { label: { code: DIFFUSION_RESTREINTE, source: 'sensitivity-label' }, signature: 'absent' } });

      const { statusCode, xlsx: preparedXlsx } = await preparedWorkbook(xlsx, base(DIFFUSION_RESTREINTE));

      assert.equal(statusCode, 200);
      assert.ok(preparedXlsx !== null);
      assert.equal((await JSZip.loadAsync(preparedXlsx)).file('docMetadata/LabelInfo.xml'), null);
    });

    it('prepares a workbook that another tool labelled, whose binding it replaces', async () => {
      const { statusCode, xlsx } = await preparedWorkbook(await minimalXlsx([], [bindingOf(originatorLabel('DEMO-FR', DEMO_POLICY_URI, 'DIFFUSION RESTREINTE'))]), base(DIFFUSION_RESTREINTE));

      assert.equal(statusCode, 200);
      assert.ok(xlsx !== null);
      const bindings = [...(await customXmlTexts(await JSZip.loadAsync(xlsx))).values()].filter((xml) => xml.includes(BINDING_NAMESPACE));
      assert.equal(bindings.length, 1);
      assert.doesNotMatch(bindings[0] ?? '', /word\/document\.xml/);
    });

    for (const [kind, body, reason] of [
      ['a legacy Excel file', async () => compoundFile(['Workbook']), 'compound-file'],
      ['a workbook with several document label bindings', async () => minimalXlsx([], [`<mb:BindingInformation xmlns:mb="${BINDING_NAMESPACE}"/>`, `<mb:BindingInformation xmlns:mb="${BINDING_NAMESPACE}"/>`]), 'several-bindings'],
      ['a workbook whose binding is not well-formed XML', async () => minimalXlsx([], [`<mb:BindingInformation xmlns:mb="${BINDING_NAMESPACE}">`]), 'malformed-binding'],
    ] as const) {
      it(`refuses ${kind}, as a text document`, async () => {
        const { statusCode, json } = await preparedWorkbook(await body(), base(DIFFUSION_RESTREINTE));

        assert.equal(statusCode, 422);
        assert.equal(reasonOf(json), reason);
      });
    }

    it('names both formats when it refuses a legacy Office document', async () => {
      const { json } = await preparedWorkbook(compoundFile(['Workbook']), base(DIFFUSION_RESTREINTE));

      assert.deepEqual(json, { error: 'The file is a legacy Office document, not a DOCX or XLSX package', reason: 'compound-file' });
    });

    it('refuses a base label that the security policy does not know for a workbook', async () => {
      const { statusCode, json } = await preparedWorkbook(await minimalXlsx(), base('DEMO-FR:7'));

      assert.equal(statusCode, 422);
      assert.equal(reasonOf(json), 'unknown-label');
    });

    it('refuses a workbook whose portion labels in clear designate no label', async () => {
      const { statusCode, json } = await preparedWorkbook(await minimalXlsx([{ id: 'p1', label: 'DEMO-FR:9' }]), base(DIFFUSION_RESTREINTE));

      assert.equal(statusCode, 422);
      assert.equal(reasonOf(json), 'portion-labels');
    });
  });

  describe('the reading of the label an uploaded file carries', () => {
    it('reads the base label the platform wrote, and a binding signature that matches', async () => {
      const { docx } = await prepared(await minimalDocx(), base('DEMO-FR:2/2.1'));
      assert.ok(docx !== null);
      const { stored } = await signedAndStored(docx);

      assert.deepEqual(await read(stored), { statusCode: 200, json: { label: { code: 'DEMO-FR:2/2.1', source: 'base-label' }, signature: 'matched' } });
    });

    it('reads the document label of a binding another tool wrote, without its informative categories', async () => {
      const releasableToNato = '<slab:Category Type="PERMISSIVE" TagName="Releasable To"><slab:GenericValue>NATO</slab:GenericValue></slab:Category>';
      const composition = '<slab:Category Type="INFORMATIVE" TagName="Composition"><slab:GenericValue>MORE RESTRICTIVE PORTIONS</slab:GenericValue></slab:Category>';
      const docx = await minimalDocx([], [bindingOf(originatorLabel('DEMO-FR', DEMO_POLICY_URI, 'DIFFUSION RESTREINTE', releasableToNato + composition))]);

      assert.deepEqual(await read(docx), { statusCode: 200, json: { label: { code: 'DEMO-FR:2/2.1', source: 'binding' }, signature: 'absent' } });
    });

    it('reads no label from a file that carries none', async () => {
      assert.deepEqual(await read(await minimalDocx()), { statusCode: 200, json: { label: null, signature: 'absent' } });
    });

    it('says that the binding signature no longer matches a file changed after signing', async () => {
      const { docx } = await prepared(await minimalDocx(), base(DIFFUSION_RESTREINTE));
      assert.ok(docx !== null);
      const zip = await JSZip.loadAsync((await signedAndStored(docx)).stored);
      zip.file('word/document.xml', ((await zip.file('word/document.xml')?.async('string')) ?? '').replace('Fictional text in clear', 'Fictional text changed later'));

      const { json } = await read(await zip.generateAsync({ type: 'uint8array' }));

      assert.deepEqual(json, { label: { code: DIFFUSION_RESTREINTE, source: 'base-label' }, signature: 'not-matched' });
    });

    for (const [kind, customXml, reason] of [
      ['a base label of another security policy', `<dcs:document xmlns:dcs="${DOCUMENT_NAMESPACE}" base="OTHER-FR:1" label="OTHER-FR:1"/>`, 'foreign-label'],
      ['a binding label of another security policy', bindingOf(originatorLabel('OTHER-FR', 'urn:oid:2.25.1', 'DIFFUSION RESTREINTE')), 'foreign-label'],
      ['a binding label under the demo policy name with another identifier', bindingOf(originatorLabel('DEMO-FR', 'urn:oid:2.25.1', 'DIFFUSION RESTREINTE')), 'foreign-label'],
      ['a binding label that the demo policy does not define', bindingOf(originatorLabel('DEMO-FR', DEMO_POLICY_URI, 'TRES SECRET')), 'invalid-label'],
    ] as const) {
      it(`refuses ${kind}`, async () => {
        const { statusCode, json } = await read(await minimalDocx([], [customXml]));

        assert.equal(statusCode, 422);
        assert.equal(reasonOf(json), reason);
      });
    }

    it('refuses to read what cannot become a document, as the preparation does', async () => {
      const { statusCode, json } = await read(compoundFile(['\u0006DataSpaces', 'DRMEncryptedDataSpace', 'EncryptedPackage']));

      assert.equal(statusCode, 422);
      assert.equal(reasonOf(json), 'rights-management');
    });

    it('reads the document label of a binding in a Custom XML part of any name', async () => {
      const docx = await withRelatedCustomXml(await minimalDocx(), 'customXml/labels.xml', bindingOf(originatorLabel('DEMO-FR', DEMO_POLICY_URI, 'DIFFUSION RESTREINTE')));

      assert.deepEqual((await read(docx)).json, { label: { code: DIFFUSION_RESTREINTE, source: 'binding' }, signature: 'absent' });
    });

    it('says that the binding signature no longer matches a base label changed after signing, which the signature does not cover', async () => {
      const { docx } = await prepared(await minimalDocx(), base(DIFFUSION_RESTREINTE));
      assert.ok(docx !== null);
      const zip = await JSZip.loadAsync((await signedAndStored(docx)).stored);
      const [basePart] = [...(await customXmlTexts(zip)).entries()].filter(([, root]) => root.includes(DOCUMENT_NAMESPACE)).map(([part]) => part);
      assert.ok(basePart !== undefined);
      zip.file(basePart, `<dcs:document xmlns:dcs="${DOCUMENT_NAMESPACE}" base="DEMO-FR:1" label="DEMO-FR:1"/>`);

      const { json } = await read(await zip.generateAsync({ type: 'uint8array' }));

      assert.deepEqual(json, { label: { code: 'DEMO-FR:1', source: 'base-label' }, signature: 'not-matched' });
    });
  });

  describe('the reading of a Word file\'s sensitivity label', () => {
    async function readWith(metadata: { properties: string | null; labelList: string | null }): Promise<unknown> {
      return (await read(await withLabelMetadata(await minimalDocx(), metadata))).json;
    }

    it('reads the mapped tenant\'s label from its Sensitivity Label Information element, whatever the case of its ids', async () => {
      // Stale custom properties give another label: the element decides.
      const json = await readWith({
        properties: wordLabelProperties(SENSITIVITY_LABELS.diffusionRestreinte, DEMO_TENANT, 2),
        labelList: wordLabelElement(SENSITIVITY_LABELS.nato.toUpperCase(), DEMO_TENANT.toUpperCase()),
      });

      assert.deepEqual(json, { label: { code: 'DEMO-FR:2/2.1', source: 'sensitivity-label' }, signature: 'absent' });
    });

    it('reads the mapped tenant\'s label from custom properties alone', async () => {
      const json = await readWith({ properties: wordLabelProperties(SENSITIVITY_LABELS.diffusionRestreinte, DEMO_TENANT, 2), labelList: null });

      assert.deepEqual(json, { label: { code: DIFFUSION_RESTREINTE, source: 'sensitivity-label' }, signature: 'absent' });
    });

    it('reads the mapped tenant\'s label from custom properties when the part has no element for the tenant', async () => {
      const json = await readWith({ properties: wordLabelProperties(SENSITIVITY_LABELS.diffusionRestreinte, DEMO_TENANT, 2), labelList: wordLabelElement(randomUUID(), OTHER_TENANT) });

      assert.deepEqual(json, { label: { code: DIFFUSION_RESTREINTE, source: 'sensitivity-label' }, signature: 'absent' });
    });

    for (const [kind, metadata] of [
      ['an element that marks the tenant\'s label removed, whatever the custom properties say', { properties: wordLabelProperties(SENSITIVITY_LABELS.nato, DEMO_TENANT, 2), labelList: wordLabelElement('', DEMO_TENANT, true) }],
      ['a sensitivity label that the mapping does not know', { properties: wordLabelProperties(randomUUID(), DEMO_TENANT, 2), labelList: null }],
      ['a disabled sensitivity label', { properties: wordLabelProperties(SENSITIVITY_LABELS.nato, DEMO_TENANT, 2, { enabled: 'false' }), labelList: null }],
      ['two sensitivity labels that the mapping knows', { properties: wordLabelProperties(SENSITIVITY_LABELS.nato, DEMO_TENANT, 2) + wordLabelProperties(SENSITIVITY_LABELS.diffusionRestreinte, DEMO_TENANT, 9), labelList: null }],
      ['two elements for the tenant', { properties: null, labelList: wordLabelElement(SENSITIVITY_LABELS.nato, DEMO_TENANT) + wordLabelElement(SENSITIVITY_LABELS.diffusionRestreinte, DEMO_TENANT) }],
      ['another tenant\'s sensitivity label', { properties: wordLabelProperties(SENSITIVITY_LABELS.nato, OTHER_TENANT, 2), labelList: wordLabelElement(SENSITIVITY_LABELS.nato, OTHER_TENANT) }],
    ] as const) {
      it(`reads no label from ${kind}`, async () => {
        assert.deepEqual(await readWith(metadata), { label: null, signature: 'absent' });
      });
    }

    it('reads the platform\'s base label rather than a sensitivity label', async () => {
      const docx = await withLabelMetadata(await minimalDocx([], [`<dcs:document xmlns:dcs="${DOCUMENT_NAMESPACE}" base="DEMO-FR:1" label="DEMO-FR:1"/>`]), {
        properties: wordLabelProperties(SENSITIVITY_LABELS.nato, DEMO_TENANT, 2),
        labelList: null,
      });

      assert.deepEqual((await read(docx)).json, { label: { code: 'DEMO-FR:1', source: 'base-label' }, signature: 'absent' });
    });

    it('reads no sensitivity label without a label mapping', async () => {
      const unmapped = await buildPolicyServer({
        spifDirectory: DEMO_SPIFS,
        bindingSignature: { secret: SECRET, signer: { privateKey: await readFile(path.join(keys, 'signer.key'), 'utf8'), certificate } },
      });
      try {
        const docx = await withLabelMetadata(await minimalDocx(), { properties: wordLabelProperties(SENSITIVITY_LABELS.nato, DEMO_TENANT, 2), labelList: null });
        const response = await unmapped.inject({ method: 'POST', url: '/uploads/read', headers: { 'content-type': DOCX_TYPE, authorization: `Bearer ${SECRET}` }, payload: Buffer.from(docx) });

        assert.deepEqual(response.json(), { label: null, signature: 'absent' });
      } finally {
        await unmapped.close();
      }
    });

    it('reads no label from a sensitivity label that the mapping pairs with several labels, nor from it and another', async () => {
      const [paired, single] = [randomUUID(), randomUUID()];
      const mappingFile = path.join(keys, 'several.label-mapping.json');
      await writeFile(
        mappingFile,
        JSON.stringify({
          tenant: DEMO_TENANT,
          labels: { 'DEMO-FR:1': { id: paired, name: 'Fictional-Paired' }, 'DEMO-FR:2': { id: paired, name: 'Fictional-Paired' }, 'DEMO-FR:2/2.1': { id: single, name: 'Fictional-Single' } },
        }),
      );
      const several = await buildPolicyServer({
        spifDirectory: DEMO_SPIFS,
        labelMappingFile: mappingFile,
        bindingSignature: { secret: SECRET, signer: { privateKey: await readFile(path.join(keys, 'signer.key'), 'utf8'), certificate } },
      });
      try {
        const readUnder = async (properties: string): Promise<unknown> => {
          const docx = await withLabelMetadata(await minimalDocx(), { properties, labelList: null });
          return (await several.inject({ method: 'POST', url: '/uploads/read', headers: { 'content-type': DOCX_TYPE, authorization: `Bearer ${SECRET}` }, payload: Buffer.from(docx) })).json();
        };

        assert.deepEqual(await readUnder(wordLabelProperties(paired, DEMO_TENANT, 2)), { label: null, signature: 'absent' });
        assert.deepEqual(await readUnder(wordLabelProperties(paired, DEMO_TENANT, 2) + wordLabelProperties(single, DEMO_TENANT, 9)), { label: null, signature: 'absent' });
        assert.deepEqual(await readUnder(wordLabelProperties(single, DEMO_TENANT, 2)), { label: { code: 'DEMO-FR:2/2.1', source: 'sensitivity-label' }, signature: 'absent' });
      } finally {
        await several.close();
      }
    });
  });

  describe('the removal of the Sensitivity Label Information part', () => {
    // The custom properties of a stored package, by name.
    async function propertyValues(stored: Uint8Array): Promise<Map<string, string>> {
      const xml = (await (await JSZip.loadAsync(stored)).file('docProps/custom.xml')?.async('string')) ?? '<none/>';
      const properties = Array.from(new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagName('property'));
      return new Map(properties.map((property) => [property.getAttribute('name') ?? '', property.textContent ?? '']));
    }

    async function preparedAndSigned(metadata: { properties: string | null; labelList: string | null }): Promise<{ stored: Uint8Array; bindingXml: string }> {
      const { docx } = await prepared(await withLabelMetadata(await minimalDocx(), metadata), base('DEMO-FR:2/2.1'));
      assert.ok(docx !== null);
      return signedAndStored(docx);
    }

    it('removes the part, and keeps every organisation\'s label in custom properties', async () => {
      const [applied, stale, removed] = [randomUUID(), randomUUID(), randomUUID()];
      const THIRD_TENANT = '22222222-3333-4444-5555-666666666666';
      const { stored, bindingXml } = await preparedAndSigned({
        // Stale properties for each tenant that has an element.
        properties:
          wordLabelProperties(SENSITIVITY_LABELS.diffusionRestreinte, DEMO_TENANT, 2) +
          wordLabelProperties(stale, OTHER_TENANT, 9) +
          wordLabelProperties(removed, THIRD_TENANT, 16),
        labelList: wordLabelElement(SENSITIVITY_LABELS.nato, DEMO_TENANT) + wordLabelElement(applied, OTHER_TENANT) + wordLabelElement('', THIRD_TENANT, true),
      });

      const zip = await JSZip.loadAsync(stored);
      assert.equal(zip.file('docMetadata/LabelInfo.xml'), null);
      assert.doesNotMatch((await zip.file('_rels/.rels')?.async('string')) ?? '', /classificationlabels/);
      assert.doesNotMatch((await zip.file('[Content_Types].xml')?.async('string')) ?? '', /LabelInfo/);
      const values = await propertyValues(stored);
      const names = [...values.keys()];
      // The mapped tenant's label, as the platform writes it.
      assert.equal(values.get(`MSIP_Label_${SENSITIVITY_LABELS.nato}_Name`), 'DCS-Diffusion-Restreinte-OTAN');
      assert.equal(values.get(`MSIP_Label_${SENSITIVITY_LABELS.nato}_Method`), 'Privileged');
      assert.ok(!names.some((name) => name.includes(SENSITIVITY_LABELS.diffusionRestreinte)));
      // The other tenant's label, which only its element gave.
      assert.deepEqual(
        names.filter((name) => name.includes(applied)).map((name) => name.slice(`MSIP_Label_${applied}_`.length)),
        ['Enabled', 'SetDate', 'Method', 'SiteId', 'ActionId', 'ContentBits'],
      );
      assert.equal(values.get(`MSIP_Label_${applied}_SiteId`), OTHER_TENANT);
      assert.equal(values.get(`MSIP_Label_${applied}_Method`), 'Privileged');
      assert.ok(!names.some((name) => name.includes(stale)));
      // The third tenant's removed label does not come back.
      assert.ok(!names.some((name) => name.includes(removed)));
      assert.equal((await verifyWithXmlsec(stored, bindingXml, certificate)).status, 0);
    });

    it('keeps the date and the action id that custom properties alone gave the mapped tenant\'s label, while it stays', async () => {
      const actionId = randomUUID();

      const { stored } = await preparedAndSigned({ properties: wordLabelProperties(SENSITIVITY_LABELS.nato, DEMO_TENANT, 2, { actionId }), labelList: null });

      const values = await propertyValues(stored);
      assert.deepEqual([values.get(`MSIP_Label_${SENSITIVITY_LABELS.nato}_SetDate`), values.get(`MSIP_Label_${SENSITIVITY_LABELS.nato}_ActionId`)], [WORD_SET_DATE, actionId]);
    });

    for (const [kind, labelList] of [
      ['applies the same label', wordLabelElement(SENSITIVITY_LABELS.nato, DEMO_TENANT)],
      ['removed the label', wordLabelElement('', DEMO_TENANT, true)],
    ] as const) {
      it(`renews them when the tenant's element, which ${kind}, decided`, async () => {
        const actionId = randomUUID();

        const { stored } = await preparedAndSigned({ properties: wordLabelProperties(SENSITIVITY_LABELS.nato, DEMO_TENANT, 2, { actionId }), labelList });

        const values = await propertyValues(stored);
        assert.notEqual(values.get(`MSIP_Label_${SENSITIVITY_LABELS.nato}_SetDate`), WORD_SET_DATE);
        assert.notEqual(values.get(`MSIP_Label_${SENSITIVITY_LABELS.nato}_ActionId`), actionId);
        assert.equal(values.get(`MSIP_Label_${SENSITIVITY_LABELS.nato}_Enabled`), 'true');
      });
    }

    it('leaves the properties of a tenant with several elements as they are', async () => {
      const [first, second] = [randomUUID(), randomUUID()];
      const properties = wordLabelProperties(first, OTHER_TENANT, 2);

      const { stored } = await preparedAndSigned({ properties, labelList: wordLabelElement(first, OTHER_TENANT) + wordLabelElement(second, OTHER_TENANT) });

      const values = await propertyValues(stored);
      assert.equal(values.get(`MSIP_Label_${first}_Name`), 'Fictional label');
      assert.ok(![...values.keys()].some((name) => name.includes(second)));
    });
  });
});
