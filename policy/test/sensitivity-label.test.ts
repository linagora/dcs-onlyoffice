import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DOMParser } from '@xmldom/xmldom';
import type { FastifyInstance } from 'fastify';
import JSZip from 'jszip';
import { buildPolicyServer } from '../src/server.ts';
import { verifyWithXmlsec } from './xmlsec.ts';

const DEMO_SPIFS = path.join(import.meta.dirname, '..', '..', 'deploy', 'spif');
const DEMO_LABEL_MAPPING = path.join(DEMO_SPIFS, 'demo-fr.label-mapping.json');
const TEMPLATE = path.join(import.meta.dirname, '..', '..', 'deploy', 'demo', 'documents', 'exercise-northwind.docx');
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const SECRET = 'fictional-binding-signature-secret';
const NOW = new Date('2026-09-28T09:00:00.000Z');
const CUSTOM_PROPERTIES_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties';
const VARIANT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes';
// The format identifier of user-defined properties, which Office requires of
// the sensitivity label properties ([MS-OI29500] §2.1.1724, §3.11.2).
const USER_DEFINED_PROPERTIES = '{D5CDD505-2E9C-101B-9397-08002B2CF9AE}';
// Parts ADatP-4778.2 Tables 5-2 and 5-3 require a whole-document binding to
// reference, when the package holds them.
const BINDABLE_PART = /^(word\/(document|styles|footnotes|endnotes|comments)\.xml|word\/(header|footer)\d*\.xml|word\/media\/.+|docProps\/(core|app|custom)\.xml)$/;
// Codes of the demo SPIF's labels.
const DIFFUSION_RESTREINTE = 'DEMO-FR:2';
const SPECIAL_FRANCE = 'DEMO-FR:2/1.1';
// The fictional tenant and label of the example label mapping.
const DEMO_TENANT = '00000000-0000-0000-0000-000000000000';
const DIFFUSION_RESTREINTE_SENSITIVITY_LABEL = '10000000-0000-4000-8000-000000000002';

interface SigningAnswer {
  signed: { part: string; xml: string };
  parts: { part: string; xml: string }[];
  replacement: unknown;
}

interface CustomProperty {
  fmtid: string | null;
  pid: string | null;
  name: string;
  type: string | null;
  value: string;
}

describe('the sensitivity label of a stored document', () => {
  let server: FastifyInstance;
  let keys = '';
  let certificate = '';

  before(async () => {
    keys = await mkdtemp(path.join(tmpdir(), 'sensitivity-label-keys-'));
    execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', path.join(keys, 'signer.key')]);
    execFileSync('openssl', ['req', '-new', '-x509', '-key', path.join(keys, 'signer.key'), '-out', path.join(keys, 'signer.pem'), '-days', '30', '-subj', '/CN=Fictional signer']);
    certificate = await readFile(path.join(keys, 'signer.pem'), 'utf8');
    server = await signingServer(DEMO_LABEL_MAPPING);
  });
  after(async () => {
    await server.close();
    await rm(keys, { recursive: true, force: true });
  });

  // A policy service that signs, with the given label mapping or none, at the
  // time the clock tells.
  async function signingServer(labelMappingFile: string | null, clock: () => Date = () => NOW): Promise<FastifyInstance> {
    return buildPolicyServer({
      spifDirectory: DEMO_SPIFS,
      ...(labelMappingFile === null ? {} : { labelMappingFile }),
      bindingSignature: {
        secret: SECRET,
        signer: { privateKey: await readFile(path.join(keys, 'signer.key'), 'utf8'), certificate: await readFile(path.join(keys, 'signer.pem'), 'utf8') },
      },
      now: clock,
    });
  }

  // A label mapping file for the demo tenant with the given entries.
  async function labelMappingFile(labels: Record<string, { id: string; name: string }>): Promise<string> {
    const file = path.join(keys, `label-mapping-${Object.keys(labels).length}.json`);
    await writeFile(file, JSON.stringify({ tenant: DEMO_TENANT, labels }));
    return file;
  }

  // The demo template with a base label, a placeholder for each portion
  // label, and the binding the panel writes.
  async function labelledDocument(base: string, portions: string[] = [], template: Uint8Array | null = null): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync(template ?? (await readFile(TEMPLATE)));
    const placeholders = portions
      .map((label, index) => `<w:sdt><w:sdtPr><w:tag w:val="${JSON.stringify({ v: 1, id: `portion-${index}`, label }).replaceAll('"', '&quot;')}"/></w:sdtPr><w:sdtContent><w:p/></w:sdtContent></w:sdt>`)
      .join('');
    zip.file('word/document.xml', ((await zip.file('word/document.xml')?.async('string')) ?? '').replace('<w:body>', `<w:body>${placeholders}`));
    const computed = await server.inject({
      method: 'POST',
      url: '/policies/DEMO-FR/document-label',
      payload: { base, portions, parts: Object.keys(zip.files).filter((name) => BINDABLE_PART.test(name)).sort() },
    });
    assert.equal(computed.statusCode, 200);
    zip.file('customXml/item1.xml', (computed.json() as { xml: string }).xml); // SAFETY: the answer asserted just above
    zip.file('customXml/item2.xml', `<dcs:document xmlns:dcs="urn:linagora:dcs:document:1" base="${base}"/>`);
    return zip.generateAsync({ type: 'uint8array' });
  }

  // What the policy service answers when the portal has a package signed.
  // `stored` is the package as stored before this save, whose custom
  // properties the portal sends along.
  async function signingAnswer(docx: Uint8Array, signer: FastifyInstance = server, stored: Uint8Array | null = null): Promise<SigningAnswer> {
    // As the portal sends them: empty when the stored file has none.
    const storedProperties = stored === null ? null : ((await (await JSZip.loadAsync(stored)).file('docProps/custom.xml')?.async('string')) ?? '');
    const response = await signer.inject({
      method: 'POST',
      url: '/bindings/sign',
      headers: {
        'content-type': DOCX_TYPE,
        authorization: `Bearer ${SECRET}`,
        ...(storedProperties === null ? {} : { 'x-stored-custom-properties': Buffer.from(storedProperties).toString('base64') }),
      },
      payload: Buffer.from(docx),
    });
    assert.equal(response.statusCode, 200);
    return response.json() as SigningAnswer; // SAFETY: the status asserted just above
  }

  // A package as the portal stores it, with every part the policy service
  // wrote when it signed, and that answer.
  async function signedAndStored(docx: Uint8Array, signer: FastifyInstance = server, previous: Uint8Array | null = null): Promise<{ answer: SigningAnswer; stored: Uint8Array }> {
    const answer = await signingAnswer(docx, signer, previous);
    const zip = await JSZip.loadAsync(docx);
    for (const written of [...answer.parts, answer.signed]) {
      zip.file(written.part, written.xml);
    }
    return { answer, stored: await zip.generateAsync({ type: 'uint8array' }) };
  }

  async function storedPackage(docx: Uint8Array, signer: FastifyInstance = server, previous: Uint8Array | null = null): Promise<Uint8Array> {
    return (await signedAndStored(docx, signer, previous)).stored;
  }

  async function customProperties(docx: Uint8Array): Promise<CustomProperty[]> {
    const xml = await (await JSZip.loadAsync(docx)).file('docProps/custom.xml')?.async('string');
    if (xml === undefined) {
      return [];
    }
    const root = new DOMParser().parseFromString(xml, 'text/xml').documentElement;
    return Array.from(root?.getElementsByTagNameNS(CUSTOM_PROPERTIES_NAMESPACE, 'property') ?? []).map((property) => {
      const value = Array.from(property.childNodes).find((node) => node.nodeType === 1 && node.namespaceURI === VARIANT_TYPES_NAMESPACE);
      return {
        fmtid: property.getAttribute('fmtid'),
        pid: property.getAttribute('pid'),
        name: property.getAttribute('name') ?? '',
        type: value?.localName ?? null,
        value: value?.textContent ?? '',
      };
    });
  }

  // A package whose custom properties part holds the given properties, as
  // lpwstr values.
  async function withCustomProperties(docx: Uint8Array, properties: [string, string][]): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync(docx);
    const content = properties
      .map(([name, value], index) => `<property fmtid="${USER_DEFINED_PROPERTIES}" pid="${index + 2}" name="${name}"><vt:lpwstr>${value}</vt:lpwstr></property>`)
      .join('');
    zip.file('docProps/custom.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="${CUSTOM_PROPERTIES_NAMESPACE}" xmlns:vt="${VARIANT_TYPES_NAMESPACE}">${content}</Properties>`);
    return zip.generateAsync({ type: 'uint8array' });
  }

  // A package whose base label part names another base label, as after the
  // panel raised it.
  async function withBaseLabel(docx: Uint8Array, base: string): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync(docx);
    zip.file('customXml/item2.xml', `<dcs:document xmlns:dcs="urn:linagora:dcs:document:1" base="${base}"/>`);
    return zip.generateAsync({ type: 'uint8array' });
  }

  // A package without custom properties, as ONLYOFFICE saves a document that
  // has none: no part, no package relationship, no content type.
  async function withoutCustomProperties(docx: Uint8Array): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync(docx);
    zip.remove('docProps/custom.xml');
    const relationships = (await zip.file('_rels/.rels')?.async('string')) ?? '';
    zip.file('_rels/.rels', relationships.replace(/<Relationship [^>]*custom-properties[^>]*\/>/, ''));
    const contentTypes = (await zip.file('[Content_Types].xml')?.async('string')) ?? '';
    zip.file('[Content_Types].xml', contentTypes.replace(/<Override [^>]*\/docProps\/custom\.xml[^>]*\/>/, ''));
    return zip.generateAsync({ type: 'uint8array' });
  }

  // The package relationships and the content type overrides of a package.
  async function packagePlumbing(docx: Uint8Array): Promise<{ relationships: Record<string, string>[]; overrides: Record<string, string>[] }> {
    const zip = await JSZip.loadAsync(docx);
    const attributesOf = async (part: string, localName: string): Promise<Record<string, string>[]> => {
      const root = new DOMParser().parseFromString((await zip.file(part)?.async('string')) ?? '', 'text/xml').documentElement;
      return Array.from(root?.getElementsByTagName(localName) ?? []).map((element) =>
        Object.fromEntries(Array.from(element.attributes).map((attribute) => [attribute.name, attribute.value])),
      );
    };
    return { relationships: await attributesOf('_rels/.rels', 'Relationship'), overrides: await attributesOf('[Content_Types].xml', 'Override') };
  }

  // A package with a Sensitivity Label Information part named `part`, its
  // package relationship and its content type, as Office writes it in a
  // tenant that enables co-authoring of encrypted files.
  async function withLabelInformation(docx: Uint8Array, part: string, target: string | null = part): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync(docx);
    zip.file(
      part,
      `<?xml version="1.0" encoding="utf-8" standalone="yes"?><clbl:labelList xmlns:clbl="http://schemas.microsoft.com/office/2020/mipLabelMetadata"><clbl:label id="{${DIFFUSION_RESTREINTE_SENSITIVITY_LABEL}}" enabled="1" method="Privileged" siteId="{${DEMO_TENANT}}" contentBits="0" removed="0" /></clbl:labelList>`,
    );
    if (target !== null) {
      const relationships = (await zip.file('_rels/.rels')?.async('string')) ?? '';
      zip.file(
        '_rels/.rels',
        relationships.replace('</Relationships>', `<Relationship Id="rIdLabels" Type="http://schemas.microsoft.com/office/2020/02/relationships/classificationlabels" Target="${target}"/></Relationships>`),
      );
    }
    const contentTypes = (await zip.file('[Content_Types].xml')?.async('string')) ?? '';
    zip.file('[Content_Types].xml', contentTypes.replace('</Types>', `<Override PartName="/${part}" ContentType="application/vnd.ms-office.classificationlabels+xml"/></Types>`));
    return zip.generateAsync({ type: 'uint8array' });
  }

  // The policy service's verdict on a stored package.
  async function verdictOf(docx: Uint8Array): Promise<unknown> {
    const response = await server.inject({
      method: 'POST',
      url: '/bindings/verify',
      headers: { 'content-type': DOCX_TYPE, authorization: `Bearer ${SECRET}` },
      payload: Buffer.from(docx),
    });
    assert.equal(response.statusCode, 200);
    return response.json();
  }

  // The sensitivity label properties of one label, by attribute name.
  function labelProperties(properties: CustomProperty[], labelId: string): Record<string, string> {
    const prefix = `MSIP_Label_${labelId}_`;
    return Object.fromEntries(properties.filter((property) => property.name.startsWith(prefix)).map((property) => [property.name.slice(prefix.length), property.value]));
  }

  it('gives a DIFFUSION RESTREINTE document the sensitivity label that the mapping pairs with it', async () => {
    const stored = await storedPackage(await labelledDocument(DIFFUSION_RESTREINTE));

    const properties = await customProperties(stored);
    const { ActionId, ...others } = labelProperties(properties, DIFFUSION_RESTREINTE_SENSITIVITY_LABEL);
    assert.deepEqual(others, {
      Enabled: 'true',
      SetDate: '2026-09-28T09:00:00Z',
      Method: 'Privileged',
      Name: 'DCS-Diffusion-Restreinte-Standard',
      SiteId: DEMO_TENANT,
      ContentBits: '0',
    });
    assert.match(ActionId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.deepEqual(
      properties.map((property) => [property.fmtid, property.type]),
      Array.from({ length: 7 }, () => [USER_DEFINED_PROPERTIES, 'lpwstr']),
    );
  });

  it('leaves out informative categories: a DIFFUSION RESTREINTE document with a SPECIAL FRANCE portion stays DIFFUSION RESTREINTE', async () => {
    const docx = await labelledDocument(DIFFUSION_RESTREINTE, [SPECIAL_FRANCE]);
    // The document label computed again from the placeholder's portion label
    // is the panel's: DIFFUSION RESTREINTE with MORE RESTRICTIVE PORTIONS.
    assert.equal((await signingAnswer(docx)).replacement, null);

    const properties = await customProperties(await storedPackage(docx));
    assert.deepEqual(
      properties.map((property) => property.name),
      ['Enabled', 'SetDate', 'Method', 'Name', 'SiteId', 'ActionId', 'ContentBits'].map((attribute) => `MSIP_Label_${DIFFUSION_RESTREINTE_SENSITIVITY_LABEL}_${attribute}`),
    );
  });

  for (const [base, id, name] of [
    ['DEMO-FR:1', '10000000-0000-4000-8000-000000000001', 'DCS-Non-Protege'],
    ['DEMO-FR:2', '10000000-0000-4000-8000-000000000002', 'DCS-Diffusion-Restreinte-Standard'],
    ['DEMO-FR:2/2.1', '10000000-0000-4000-8000-000000000003', 'DCS-Diffusion-Restreinte-OTAN'],
    ['DEMO-FR:2/1.1', '10000000-0000-4000-8000-000000000004', 'DCS-Diffusion-Restreinte-Special-France'],
  ] as const) {
    it(`gives a ${base} document the sensitivity label ${name}`, async () => {
      const stored = await storedPackage(await labelledDocument(base));

      const { ActionId, ...label } = labelProperties(await customProperties(stored), id);
      assert.deepEqual(label, { Enabled: 'true', SetDate: '2026-09-28T09:00:00Z', Method: 'Privileged', Name: name, SiteId: DEMO_TENANT, ContentBits: '0' });
      assert.match(ActionId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  }

  it('gives no sensitivity label to a document whose label the mapping does not pair', async () => {
    const partial = await signingServer(await labelMappingFile({ [DIFFUSION_RESTREINTE]: { id: DIFFUSION_RESTREINTE_SENSITIVITY_LABEL, name: 'DCS-Diffusion-Restreinte-Standard' } }));
    try {
      const answer = await signingAnswer(await labelledDocument('DEMO-FR:1'), partial);

      assert.deepEqual(answer.parts, []);
    } finally {
      await partial.close();
    }
  });

  it('gives no sensitivity label without a label mapping', async () => {
    const unmapped = await signingServer(null);
    try {
      const answer = await signingAnswer(await labelledDocument(DIFFUSION_RESTREINTE), unmapped);

      assert.deepEqual(answer.parts, []);
    } finally {
      await unmapped.close();
    }
  });

  it('replaces the earlier sensitivity label of the tenant, and keeps the labels of other tenants and other properties', async () => {
    const special = '10000000-0000-4000-8000-000000000004';
    const partner = 'aaaaaaaa-0000-4000-8000-00000000000a';
    const partnerTenant = 'bbbbbbbb-0000-4000-8000-00000000000b';
    const docx = await withCustomProperties(await labelledDocument(DIFFUSION_RESTREINTE), [
      ['Project', 'Northwind'],
      [`MSIP_Label_${special}_Enabled`, 'true'],
      [`MSIP_Label_${special}_SiteId`, `{${DEMO_TENANT.toUpperCase()}}`],
      [`MSIP_Label_${partner}_Enabled`, 'true'],
      [`MSIP_Label_${partner}_SiteId`, partnerTenant],
    ]);

    const properties = await customProperties(await storedPackage(docx));

    const names = properties.map((property) => property.name);
    assert.deepEqual(names.filter((name) => !name.startsWith(`MSIP_Label_${DIFFUSION_RESTREINTE_SENSITIVITY_LABEL}_`)), [
      'Project',
      `MSIP_Label_${partner}_Enabled`,
      `MSIP_Label_${partner}_SiteId`,
    ]);
    assert.equal(labelProperties(properties, DIFFUSION_RESTREINTE_SENSITIVITY_LABEL)['Enabled'], 'true');
    assert.equal(new Set(properties.map((property) => property.pid)).size, properties.length);
    assert.ok(properties.every((property) => Number(property.pid) >= 2));
  });

  it('keeps the date and the action id of a sensitivity label while the label stays, and renews them when it changes', async () => {
    let now = NOW;
    const saving = await signingServer(DEMO_LABEL_MAPPING, () => now);
    try {
      const first = await storedPackage(await labelledDocument(DIFFUSION_RESTREINTE), saving);
      now = new Date('2026-09-28T10:30:00.000Z');
      const second = await storedPackage(first, saving);
      now = new Date('2026-09-28T11:45:00.000Z');
      const raised = await storedPackage(await withBaseLabel(second, SPECIAL_FRANCE), saving);

      const kept = labelProperties(await customProperties(second), DIFFUSION_RESTREINTE_SENSITIVITY_LABEL);
      const original = labelProperties(await customProperties(first), DIFFUSION_RESTREINTE_SENSITIVITY_LABEL);
      assert.deepEqual([kept['SetDate'], kept['ActionId']], ['2026-09-28T09:00:00Z', original['ActionId']]);
      const renewed = labelProperties(await customProperties(raised), '10000000-0000-4000-8000-000000000004');
      assert.equal(renewed['SetDate'], '2026-09-28T11:45:00Z');
      assert.notEqual(renewed['ActionId'], original['ActionId']);
    } finally {
      await saving.close();
    }
  });

  it('adds the custom properties part, with its package relationship and its content type, to a package that lacks them', async () => {
    const docx = await withoutCustomProperties(await labelledDocument(DIFFUSION_RESTREINTE));

    const { answer, stored } = await signedAndStored(docx);

    assert.deepEqual(answer.parts.map((written) => written.part).sort(), ['[Content_Types].xml', '_rels/.rels', 'docProps/custom.xml']);
    assert.equal(labelProperties(await customProperties(stored), DIFFUSION_RESTREINTE_SENSITIVITY_LABEL)['Enabled'], 'true');
    const { relationships, overrides } = await packagePlumbing(stored);
    const custom = relationships.filter((relationship) => relationship['Type'] === 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties');
    assert.deepEqual(custom.map((relationship) => relationship['Target']), ['docProps/custom.xml']);
    assert.equal(new Set(relationships.map((relationship) => relationship['Id'])).size, relationships.length);
    assert.deepEqual(
      overrides.filter((override) => override['PartName'] === '/docProps/custom.xml').map((override) => override['ContentType']),
      ['application/vnd.openxmlformats-officedocument.custom-properties+xml'],
    );
  });

  it('has the binding reference the custom properties part, so that the signature covers the sensitivity label', async () => {
    // Saved without custom properties, a package's binding references none.
    const withoutProperties = await labelledDocument(DIFFUSION_RESTREINTE, [], await withoutCustomProperties(await readFile(TEMPLATE)));
    for (const docx of [await labelledDocument(DIFFUSION_RESTREINTE), withoutProperties]) {
      const { answer, stored } = await signedAndStored(docx);

      const verification = await verifyWithXmlsec(stored, answer.signed.xml, certificate);
      const bindable = Object.keys((await JSZip.loadAsync(stored)).files).filter((name) => BINDABLE_PART.test(name));
      assert.ok(verification.references.includes('docProps/custom.xml'));
      assert.deepEqual([verification.status, verification.manifest], [0, `${bindable.length}/${bindable.length}`]);
    }
  });

  for (const [problem, mapping, message] of [
    ['a label the security policy lacks', { tenant: DEMO_TENANT, labels: { 'DEMO-FR:7': { id: DIFFUSION_RESTREINTE_SENSITIVITY_LABEL, name: 'DCS-Unknown' } } }, /DEMO-FR:7/],
    ['a label with an informative category', { tenant: DEMO_TENANT, labels: { 'DEMO-FR:2/3.1': { id: DIFFUSION_RESTREINTE_SENSITIVITY_LABEL, name: 'DCS-More-Restrictive-Portions' } } }, /DEMO-FR:2\/3\.1/],
    ['a malformed tenant id', { tenant: 'fictional-tenant', labels: {} }, /tenant/],
    ['a malformed label id', { tenant: DEMO_TENANT, labels: { [DIFFUSION_RESTREINTE]: { id: '10000000-XYZ', name: 'DCS-Diffusion-Restreinte' } } }, /10000000-XYZ/],
    ['a label without a name', { tenant: DEMO_TENANT, labels: { [DIFFUSION_RESTREINTE]: { id: DIFFUSION_RESTREINTE_SENSITIVITY_LABEL, name: '' } } }, /name/],
    ['no labels object', { tenant: DEMO_TENANT }, /labels/],
  ] as const) {
    it(`refuses to start with a label mapping that holds ${problem}`, async () => {
      const file = path.join(keys, 'invalid-label-mapping.json');
      await writeFile(file, JSON.stringify(mapping));

      await assert.rejects(signingServer(file), message);
    });
  }

  it('keeps the date and the action id of the label of the stored file when the save comes back without it, as within an editing session', async () => {
    let now = NOW;
    const saving = await signingServer(DEMO_LABEL_MAPPING, () => now);
    try {
      const saved = await labelledDocument(DIFFUSION_RESTREINTE);
      const first = await storedPackage(saved, saving);
      now = new Date('2026-09-28T10:30:00.000Z');
      // The editor never sees the properties the portal wrote: its next save
      // comes back without them.
      const second = await storedPackage(saved, saving, first);

      const original = labelProperties(await customProperties(first), DIFFUSION_RESTREINTE_SENSITIVITY_LABEL);
      const kept = labelProperties(await customProperties(second), DIFFUSION_RESTREINTE_SENSITIVITY_LABEL);
      assert.deepEqual([kept['SetDate'], kept['ActionId']], [original['SetDate'], original['ActionId']]);
    } finally {
      await saving.close();
    }
  });

  it('sets the date and the action id again when a label comes back within an editing session', async () => {
    let now = NOW;
    const saving = await signingServer(DEMO_LABEL_MAPPING, () => now);
    try {
      const opened = await storedPackage(await labelledDocument(DIFFUSION_RESTREINTE), saving);
      now = new Date('2026-09-28T10:30:00.000Z');
      const raised = await storedPackage(await withBaseLabel(opened, SPECIAL_FRANCE), saving, opened);
      now = new Date('2026-09-28T11:45:00.000Z');
      // The editor's copy still holds the label as the session opened.
      const lowered = await storedPackage(await withBaseLabel(opened, DIFFUSION_RESTREINTE), saving, raised);

      const back = labelProperties(await customProperties(lowered), DIFFUSION_RESTREINTE_SENSITIVITY_LABEL);
      const first = labelProperties(await customProperties(opened), DIFFUSION_RESTREINTE_SENSITIVITY_LABEL);
      assert.equal(back['SetDate'], '2026-09-28T11:45:00Z');
      assert.notEqual(back['ActionId'], first['ActionId']);
    } finally {
      await saving.close();
    }
  });

  it('sets the date and the action id again when the stored file holds no custom properties', async () => {
    let now = NOW;
    const saving = await signingServer(DEMO_LABEL_MAPPING, () => now);
    try {
      const opened = await storedPackage(await labelledDocument(DIFFUSION_RESTREINTE), saving);
      now = new Date('2026-09-28T10:30:00.000Z');
      const again = await storedPackage(opened, saving, await withoutCustomProperties(opened));

      assert.equal(labelProperties(await customProperties(again), DIFFUSION_RESTREINTE_SENSITIVITY_LABEL)['SetDate'], '2026-09-28T10:30:00Z');
    } finally {
      await saving.close();
    }
  });

  it('writes no property twice when an editor deleted only the SiteId of the label', async () => {
    const stored = await storedPackage(await labelledDocument(DIFFUSION_RESTREINTE));
    const edited = await withCustomProperties(
      stored,
      (await customProperties(stored)).filter((property) => !property.name.endsWith('_SiteId')).map((property) => [property.name, property.value]),
    );

    const names = (await customProperties(await storedPackage(edited))).map((property) => property.name.toLowerCase());

    assert.equal(new Set(names).size, names.length);
    assert.equal(names.length, 7);
  });

  it('pairs the labels of a mapping whose codes use another case', async () => {
    const lowercase = await signingServer(await labelMappingFile({ 'demo-fr:2': { id: DIFFUSION_RESTREINTE_SENSITIVITY_LABEL, name: 'DCS-Diffusion-Restreinte-Standard' } }));
    try {
      const stored = await storedPackage(await labelledDocument(DIFFUSION_RESTREINTE), lowercase);

      assert.equal(labelProperties(await customProperties(stored), DIFFUSION_RESTREINTE_SENSITIVITY_LABEL)['Enabled'], 'true');
    } finally {
      await lowercase.close();
    }
  });

  it('keeps one package relationship to the custom properties part when the part itself is missing', async () => {
    const zip = await JSZip.loadAsync(await labelledDocument(DIFFUSION_RESTREINTE));
    zip.remove('docProps/custom.xml');

    const stored = await storedPackage(await zip.generateAsync({ type: 'uint8array' }));

    const { relationships } = await packagePlumbing(stored);
    assert.equal(relationships.filter((relationship) => relationship['Type']?.endsWith('/custom-properties')).length, 1);
    assert.equal(labelProperties(await customProperties(stored), DIFFUSION_RESTREINTE_SENSITIVITY_LABEL)['Enabled'], 'true');
  });

  it('takes the sensitivity label away from a document that has no document label', async () => {
    const labelled = await storedPackage(await labelledDocument(DIFFUSION_RESTREINTE));
    const zip = await JSZip.loadAsync(labelled);
    zip.remove('customXml/item1.xml');
    zip.remove('customXml/item2.xml');

    const answer = await signingAnswer(await zip.generateAsync({ type: 'uint8array' }));

    assert.equal(answer.signed, null);
    const custom = answer.parts.find((written) => written.part === 'docProps/custom.xml');
    assert.ok(custom !== undefined, 'expected the custom properties part');
    assert.doesNotMatch(custom.xml, /MSIP_Label_/);
  });

  it('leaves a Strict custom properties part as it is', async () => {
    const strict = await withCustomProperties(await labelledDocument(DIFFUSION_RESTREINTE), [['Project', 'Northwind']]);
    const zip = await JSZip.loadAsync(strict);
    const xml = ((await zip.file('docProps/custom.xml')?.async('string')) ?? '')
      .replace(CUSTOM_PROPERTIES_NAMESPACE, 'http://purl.oclc.org/ooxml/officeDocument/customProperties')
      .replace(VARIANT_TYPES_NAMESPACE, 'http://purl.oclc.org/ooxml/officeDocument/docPropsVTypes');
    zip.file('docProps/custom.xml', xml);

    const answer = await signingAnswer(await zip.generateAsync({ type: 'uint8array' }));

    assert.deepEqual(answer.parts, []);
  });

  it('names the Sensitivity Label Information part that a stored file holds, found by its relationship type', async () => {
    const stored = await storedPackage(await labelledDocument(DIFFUSION_RESTREINTE));

    assert.deepEqual(await verdictOf(stored), { status: 'valid', labelInformationPart: null });
    // The signature covers neither the part nor its relationship: it holds.
    assert.deepEqual(await verdictOf(await withLabelInformation(stored, 'docMetadata/LabelInfo.xml')), {
      status: 'valid',
      labelInformationPart: 'docMetadata/LabelInfo.xml',
    });
  });

  it('names a Sensitivity Label Information part of another name, and in a file without labels', async () => {
    const unlabelled = await withLabelInformation(new Uint8Array(await readFile(TEMPLATE)), 'docMetadata/Labels.xml');

    assert.deepEqual(await verdictOf(unlabelled), { status: 'unlabelled', labelInformationPart: 'docMetadata/Labels.xml' });
  });

  it('finds a Sensitivity Label Information part as OPC resolves its relationship, and only through it', async () => {
    const stored = await storedPackage(await labelledDocument(DIFFUSION_RESTREINTE));
    const relative = await withLabelInformation(stored, 'docMetadata/LabelInfo.xml', './docmetadata/labelinfo.xml');
    const unrelated = await withLabelInformation(stored, 'docMetadata/LabelInfo.xml', null);
    // A relationship to a missing part comes first.
    const zip = await JSZip.loadAsync(relative);
    const relationships = (await zip.file('_rels/.rels')?.async('string')) ?? '';
    zip.file('_rels/.rels', relationships.replace('<Relationship Id="rIdLabels"', '<Relationship Id="rIdGone" Type="http://schemas.microsoft.com/office/2020/02/relationships/classificationlabels" Target="docMetadata/Gone.xml"/><Relationship Id="rIdLabels"'));
    const dangling = await zip.generateAsync({ type: 'uint8array' });

    assert.deepEqual(await verdictOf(relative), { status: 'valid', labelInformationPart: 'docMetadata/LabelInfo.xml' });
    assert.deepEqual(await verdictOf(dangling), { status: 'valid', labelInformationPart: 'docMetadata/LabelInfo.xml' });
    assert.deepEqual(await verdictOf(unrelated), { status: 'valid', labelInformationPart: null });
  });

  it('names the Sensitivity Label Information part beside an altered verdict', async () => {
    const stored = await storedPackage(await labelledDocument(DIFFUSION_RESTREINTE));
    const zip = await JSZip.loadAsync(await withLabelInformation(stored, 'docMetadata/LabelInfo.xml'));
    zip.file('docProps/app.xml', `${(await zip.file('docProps/app.xml')?.async('string')) ?? ''}<!-- changed outside the portal -->`);

    assert.deepEqual(await verdictOf(await zip.generateAsync({ type: 'uint8array' })), {
      status: 'altered',
      reason: 'Parts changed since signing',
      changedParts: ['docProps/app.xml'],
      labelInformationPart: 'docMetadata/LabelInfo.xml',
    });
  });
});
