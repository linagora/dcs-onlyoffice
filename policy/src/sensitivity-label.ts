import { randomUUID } from 'node:crypto';
import { type Document, XMLSerializer } from '@xmldom/xmldom';
import type JSZip from 'jszip';
import { escapeXml } from './adatp4774.ts';
import { childElements, childrenNamed, parseXml } from './xml.ts';

// A sensitivity label of a Microsoft 365 tenant: its id, and its unique name
// in the tenant, which is not its display name.
export interface SensitivityLabel {
  id: string;
  name: string;
}

// What the label mapping gives a document label: the mapping's tenant, and
// the sensitivity label it pairs with that label, null when it pairs none.
export interface MappedSensitivityLabel {
  tenant: string;
  label: SensitivityLabel | null;
}

// What writing a sensitivity label did to a package: its custom properties
// part, null when it has none, and the parts written.
export interface SensitivityLabelWriting {
  customPropertiesPart: string | null;
  writtenParts: string[];
}

// A GUID, as tenant and label ids are written: lowercase, without braces.
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CUSTOM_PROPERTIES_PART = 'docProps/custom.xml';
const PACKAGE_RELATIONSHIPS_PART = '_rels/.rels';
const CONTENT_TYPES_PART = '[Content_Types].xml';
const RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types';
// The package relationship to the custom properties part, Transitional and
// Strict (ECMA-376 Part 1 §15.2.12.2).
const CUSTOM_PROPERTIES_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties';
const STRICT_CUSTOM_PROPERTIES_RELATIONSHIP = 'http://purl.oclc.org/ooxml/officeDocument/relationships/customProperties';
const CUSTOM_PROPERTIES_TYPE = 'application/vnd.openxmlformats-officedocument.custom-properties+xml';
const CUSTOM_PROPERTIES_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties';
const VARIANT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes';
// Office reads the sensitivity label properties among the user-defined ones
// ([MS-OI29500] §2.1.1724, §3.11.2).
const USER_DEFINED_PROPERTIES = '{D5CDD505-2E9C-101B-9397-08002B2CF9AE}';
// MSIP_Label_<label id>_<attribute>, as the MIP SDK names them; Office
// compares property names without regard to case.
const LABEL_PROPERTY = /^MSIP_Label_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_(.+)$/i;

// A custom property as its part holds it, kept as written, and the label it
// belongs to when it is a sensitivity label's.
interface CustomProperty {
  pid: number;
  xml: string;
  value: string;
  label: { id: string; attribute: string } | null;
}

// Writes a document's sensitivity label as the custom document properties
// Office reads (ADR 0005): the tenant's earlier labels go, other tenants'
// labels and other properties stay. `stored` is the custom properties part of
// the file as stored before this save, empty when it had none, or null when
// unknown: the editor never sees the properties the platform writes, so its
// saves carry the label as the editing session opened, not as last stored.
// A Strict custom properties part is left as it is.
export async function writeSensitivityLabel(zip: JSZip, mapped: MappedSensitivityLabel, now: Date, stored: string | null): Promise<SensitivityLabelWriting> {
  const located = await customPropertiesPartOf(zip);
  const part = located?.part ?? CUSTOM_PROPERTIES_PART;
  const content = located?.present === true ? ((await zip.file(part)?.async('string')) ?? '') : null;
  if (content !== null && !isTransitional(content)) {
    return { customPropertiesPart: part, writtenParts: [] };
  }
  const existing = content === null ? [] : propertiesOf(content);
  // The tenant's labels go, and any other group of the label written, which
  // would otherwise leave two properties of the same name.
  const replaced = labelIdsOfTenant(existing, mapped.tenant);
  if (mapped.label !== null) {
    replaced.add(mapped.label.id);
  }
  const kept = existing.filter((property) => property.label === null || !replaced.has(property.label.id));
  if (mapped.label === null && kept.length === existing.length) {
    return { customPropertiesPart: content === null ? null : part, writtenParts: [] };
  }
  const earlier = stored === null ? existing : propertiesOf(stored);
  const labelProperties = mapped.label === null ? [] : labelPropertiesXml(mapped.tenant, mapped.label, enabledLabel(earlier, mapped.label.id, mapped.tenant), now, kept);
  zip.file(
    part,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="${CUSTOM_PROPERTIES_NAMESPACE}" xmlns:vt="${VARIANT_TYPES_NAMESPACE}">${[...kept.map((property) => property.xml), ...labelProperties].join('')}</Properties>`,
  );
  return { customPropertiesPart: part, writtenParts: [part, ...(await declareCustomProperties(zip, part, located !== null))] };
}

// The seven properties of a sensitivity label ([MS-OI29500] §3.11.2), after
// the kept properties' pids. A label that stays keeps when it was set and the
// action that set it.
function labelPropertiesXml(tenant: string, label: SensitivityLabel, earlier: Map<string, string> | null, now: Date, kept: CustomProperty[]): string[] {
  const firstPid = Math.max(1, ...kept.map((property) => property.pid)) + 1;
  const values: [string, string][] = [
    ['Enabled', 'true'],
    ['SetDate', earlier?.get('setdate') || now.toISOString().replace(/\.\d{3}Z$/, 'Z')],
    ['Method', 'Privileged'],
    ['Name', label.name],
    ['SiteId', tenant],
    ['ActionId', earlier?.get('actionid') || randomUUID()],
    ['ContentBits', '0'],
  ];
  return values.map(
    ([attribute, value], index) =>
      `<property fmtid="${USER_DEFINED_PROPERTIES}" pid="${firstPid + index}" name="MSIP_Label_${label.id}_${attribute}"><vt:lpwstr>${escapeXml(value)}</vt:lpwstr></property>`,
  );
}

// The custom properties part that the package relationship designates, and
// whether the package holds it; null without a relationship.
async function customPropertiesPartOf(zip: JSZip): Promise<{ part: string; present: boolean } | null> {
  const relationships = await documentOf(zip, PACKAGE_RELATIONSHIPS_PART);
  const relationship = Array.from(relationships?.getElementsByTagNameNS(RELATIONSHIPS_NAMESPACE, 'Relationship') ?? []).find((candidate) =>
    [CUSTOM_PROPERTIES_RELATIONSHIP, STRICT_CUSTOM_PROPERTIES_RELATIONSHIP].includes(candidate.getAttribute('Type') ?? ''),
  );
  const target = relationship?.getAttribute('Target')?.replace(/^\//, '') ?? null;
  return target === null ? null : { part: target, present: zip.file(target) !== null };
}

// Whether a custom properties part is in the Transitional namespaces, the only
// ones this module writes.
function isTransitional(xml: string): boolean {
  const parsed = parseXml(xml);
  return parsed.ok && parsed.root.namespaceURI === CUSTOM_PROPERTIES_NAMESPACE;
}

// Declares a custom properties part: its content type, and its package
// relationship unless it has one. Gives the parts it changed.
async function declareCustomProperties(zip: JSZip, part: string, related: boolean): Promise<string[]> {
  const relationships = await documentOf(zip, PACKAGE_RELATIONSHIPS_PART);
  const types = await documentOf(zip, CONTENT_TYPES_PART);
  const relationshipsRoot = relationships?.documentElement ?? null;
  const typesRoot = types?.documentElement ?? null;
  if (relationships === null || relationshipsRoot === null || types === null || typesRoot === null) {
    return [];
  }
  const changed: string[] = [];
  const serializer = new XMLSerializer();
  if (!related) {
    const ids = new Set(Array.from(relationships.getElementsByTagNameNS(RELATIONSHIPS_NAMESPACE, 'Relationship')).map((relationship) => relationship.getAttribute('Id')));
    let number = ids.size + 1;
    while (ids.has(`rId${number}`)) {
      number += 1;
    }
    const relationship = relationships.createElementNS(RELATIONSHIPS_NAMESPACE, 'Relationship');
    relationship.setAttribute('Id', `rId${number}`);
    relationship.setAttribute('Type', CUSTOM_PROPERTIES_RELATIONSHIP);
    relationship.setAttribute('Target', part);
    relationshipsRoot.appendChild(relationship);
    zip.file(PACKAGE_RELATIONSHIPS_PART, serializer.serializeToString(relationships));
    changed.push(PACKAGE_RELATIONSHIPS_PART);
  }
  const partName = `/${part}`;
  const declared = Array.from(types.getElementsByTagNameNS(CONTENT_TYPES_NAMESPACE, 'Override')).some((override) => override.getAttribute('PartName') === partName);
  if (!declared) {
    const override = types.createElementNS(CONTENT_TYPES_NAMESPACE, 'Override');
    override.setAttribute('PartName', partName);
    override.setAttribute('ContentType', CUSTOM_PROPERTIES_TYPE);
    typesRoot.appendChild(override);
    zip.file(CONTENT_TYPES_PART, serializer.serializeToString(types));
    changed.push(CONTENT_TYPES_PART);
  }
  return changed;
}

async function documentOf(zip: JSZip, part: string): Promise<Document | null> {
  const xml = await zip.file(part)?.async('string');
  const parsed = xml === undefined ? null : parseXml(xml);
  return parsed?.ok === true ? parsed.root.ownerDocument : null;
}

// The properties of a custom properties part; none when it is no well-formed
// XML without a DTD.
function propertiesOf(xml: string): CustomProperty[] {
  const parsed = parseXml(xml);
  if (!parsed.ok) {
    return [];
  }
  const serializer = new XMLSerializer();
  return childrenNamed(parsed.root, CUSTOM_PROPERTIES_NAMESPACE, 'property').map((element) => {
    const match = LABEL_PROPERTY.exec(element.getAttribute('name') ?? '');
    const [value] = childElements(element).filter((child) => child.namespaceURI === VARIANT_TYPES_NAMESPACE);
    return {
      pid: Number(element.getAttribute('pid')) || 0,
      xml: serializer.serializeToString(element),
      value: value?.textContent ?? '',
      label: match?.[1] === undefined || match[2] === undefined ? null : { id: match[1].toLowerCase(), attribute: match[2].toLowerCase() },
    };
  });
}

// The ids of the labels whose SiteId is the tenant.
function labelIdsOfTenant(properties: CustomProperty[], tenant: string): Set<string> {
  return new Set(
    properties.flatMap((property) => (property.label?.attribute === 'siteid' && normalizedGuid(property.value) === tenant ? [property.label.id] : [])),
  );
}

// The attribute values of a label, by lowercase attribute name, when the
// properties hold it enabled for the tenant; null otherwise.
function enabledLabel(properties: CustomProperty[], id: string, tenant: string): Map<string, string> | null {
  if (!labelIdsOfTenant(properties, tenant).has(id)) {
    return null;
  }
  const values = new Map(properties.flatMap((property) => (property.label?.id === id ? [[property.label.attribute, property.value] as const] : [])));
  return values.get('enabled')?.toLowerCase() === 'true' ? values : null;
}

// A GUID as Office may write it, braced or in capitals, in the form of GUID.
export function normalizedGuid(value: string): string {
  return value.trim().replace(/^\{|\}$/g, '').toLowerCase();
}
