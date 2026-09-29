import { randomUUID } from 'node:crypto';
import { XMLSerializer } from '@xmldom/xmldom';
import type JSZip from 'jszip';
import { escapeXml } from './adatp4774.ts';
import { appendRelationship, CONTENT_TYPES_PART, declareContentType, PACKAGE_RELATIONSHIPS_PART, partNamed, RELATIONSHIPS_NAMESPACE, xmlPartOf } from './opc.ts';
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
// The package relationship to the custom properties part, Transitional and
// Strict (ECMA-376 Part 1 §15.2.12.2).
const CUSTOM_PROPERTIES_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties';
const STRICT_CUSTOM_PROPERTIES_RELATIONSHIP = 'http://purl.oclc.org/ooxml/officeDocument/relationships/customProperties';
const CUSTOM_PROPERTIES_TYPE = 'application/vnd.openxmlformats-officedocument.custom-properties+xml';
// The package relationship to the Sensitivity Label Information part
// ([MS-OI29500] §3.4.1.5).
const LABEL_INFORMATION_RELATIONSHIP = 'http://schemas.microsoft.com/office/2020/02/relationships/classificationlabels';
// The root of a Sensitivity Label Information part ([MS-OFFCRYPTO] §2.6.4).
const LABEL_LIST_NAMESPACE = 'http://schemas.microsoft.com/office/2020/mipLabelMetadata';
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
  const custom = await customPropertiesOf(zip);
  if (!custom.transitional) {
    return { customPropertiesPart: custom.part, writtenParts: [] };
  }
  const existing = custom.properties;
  // The tenant's labels go, and any other group of the label written, which
  // would otherwise leave two properties of the same name.
  const replaced = labelIdsOfTenant(existing, mapped.tenant);
  if (mapped.label !== null) {
    replaced.add(mapped.label.id);
  }
  const kept = existing.filter((property) => property.label === null || !replaced.has(property.label.id));
  if (mapped.label === null && kept.length === existing.length) {
    return { customPropertiesPart: custom.present ? custom.part : null, writtenParts: [] };
  }
  const earlier = enabledLabel(stored === null ? existing : propertiesOf(stored), mapped.label?.id ?? '', mapped.tenant);
  const labelProperties =
    mapped.label === null
      ? []
      : labelPropertiesXml(mapped.tenant, { ...mapped.label, method: 'Privileged', contentBits: '0' }, earlier, now, nextPid(kept));
  return { customPropertiesPart: custom.part, writtenParts: await writeCustomProperties(zip, custom, [...kept.map((property) => property.xml), ...labelProperties]) };
}

// A sensitivity label to write as properties: its id, its unique name when
// known, its method and the content marking applied.
interface LabelAttributes {
  id: string;
  name: string | null;
  method: string;
  contentBits: string;
}

// The properties of a sensitivity label ([MS-OI29500] §3.11.2), from a pid
// on. A label that stays keeps when it was set and the action that set it.
function labelPropertiesXml(tenant: string, label: LabelAttributes, earlier: Map<string, string> | null, now: Date, firstPid: number): string[] {
  const values: [string, string | null][] = [
    ['Enabled', 'true'],
    ['SetDate', earlier?.get('setdate') || now.toISOString().replace(/\.\d{3}Z$/, 'Z')],
    ['Method', label.method],
    ['Name', label.name],
    ['SiteId', tenant],
    ['ActionId', earlier?.get('actionid') || randomUUID()],
    ['ContentBits', label.contentBits],
  ];
  return values
    .flatMap(([attribute, value]) => (value === null ? [] : [[attribute, value] as const]))
    .map(
      ([attribute, value], index) =>
        `<property fmtid="${USER_DEFINED_PROPERTIES}" pid="${firstPid + index}" name="MSIP_Label_${label.id}_${attribute}"><vt:lpwstr>${escapeXml(value)}</vt:lpwstr></property>`,
    );
}

// The pid after the kept properties'.
function nextPid(kept: CustomProperty[]): number {
  return Math.max(1, ...kept.map((property) => property.pid)) + 1;
}

// A package's custom properties: the part its relationship designates, or
// the customary one; whether the relationship and the part are there; and
// its properties, which this module reads and writes only in a Transitional
// part.
async function customPropertiesOf(zip: JSZip): Promise<CustomProperties> {
  const located = await customPropertiesPartOf(zip);
  const part = located?.part ?? CUSTOM_PROPERTIES_PART;
  const content = located?.present === true ? ((await zip.file(part)?.async('string')) ?? '') : null;
  const transitional = content === null || isTransitional(content);
  return { part, related: located !== null, present: content !== null, transitional, properties: content === null || !transitional ? [] : propertiesOf(content) };
}

interface CustomProperties {
  part: string;
  related: boolean;
  present: boolean;
  transitional: boolean;
  properties: CustomProperty[];
}

// Writes a Transitional custom properties part and declares it; gives the
// parts written.
async function writeCustomProperties(zip: JSZip, custom: CustomProperties, properties: string[]): Promise<string[]> {
  zip.file(
    custom.part,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="${CUSTOM_PROPERTIES_NAMESPACE}" xmlns:vt="${VARIANT_TYPES_NAMESPACE}">${properties.join('')}</Properties>`,
  );
  return [custom.part, ...(await declareCustomProperties(zip, custom.part, custom.related))];
}

// The custom properties part that the package relationship designates, and
// whether the package holds it; null without a relationship.
async function customPropertiesPartOf(zip: JSZip): Promise<{ part: string; present: boolean } | null> {
  const [target] = await relationshipTargets(zip, [CUSTOM_PROPERTIES_RELATIONSHIP, STRICT_CUSTOM_PROPERTIES_RELATIONSHIP]);
  if (target === undefined) {
    return null;
  }
  const present = partNamed(zip, target);
  return { part: present ?? target, present: present !== null };
}

// The parts that the package relationships of the given types designate, as
// their targets name them from the package root.
async function relationshipTargets(zip: JSZip, types: string[]): Promise<string[]> {
  const relationships = await xmlPartOf(zip, PACKAGE_RELATIONSHIPS_PART);
  return Array.from(relationships?.getElementsByTagNameNS(RELATIONSHIPS_NAMESPACE, 'Relationship') ?? [])
    .filter((relationship) => types.includes(relationship.getAttribute('Type') ?? ''))
    .map((relationship) => (relationship.getAttribute('Target') ?? '').replace(/^(\.?\/)+/, ''))
    .filter((target) => target !== '');
}

// The Sensitivity Label Information part a package holds, found through its
// package relationship; null when it holds none. The platform never writes
// one (ADR 0005), and ONLYOFFICE drops it at each save.
export async function labelInformationPartOf(zip: JSZip): Promise<string | null> {
  const parts = (await relationshipTargets(zip, [LABEL_INFORMATION_RELATIONSHIP])).map((target) => partNamed(zip, target));
  return parts.find((part) => part !== null) ?? null;
}

// What a tenant's element in the Sensitivity Label Information part says: the
// label applied, null for a removed or disabled one, or "unreadable" when the
// tenant has several elements, which [MS-OFFCRYPTO] §2.6.5.4 forbids.
type TenantLabel = LabelAttributes | null | 'unreadable';

// The elements of a package's Sensitivity Label Information part, by tenant,
// ids lowercase without braces; none without the part.
async function labelInformationOf(zip: JSZip): Promise<Map<string, TenantLabel>> {
  const part = await labelInformationPartOf(zip);
  const root = part === null ? null : ((await xmlPartOf(zip, part))?.documentElement ?? null);
  const labels = new Map<string, TenantLabel>();
  if (root === null || root.namespaceURI !== LABEL_LIST_NAMESPACE || root.localName !== 'labelList') {
    return labels;
  }
  for (const element of childrenNamed(root, LABEL_LIST_NAMESPACE, 'label')) {
    const tenant = normalizedGuid(element.getAttribute('siteId') ?? '');
    const id = normalizedGuid(element.getAttribute('id') ?? '');
    const applied = isTrue(element.getAttribute('enabled')) && !isTrue(element.getAttribute('removed')) && GUID.test(id);
    const label = applied ? { id, name: null, method: element.getAttribute('method') || 'Standard', contentBits: element.getAttribute('contentBits') || '0' } : null;
    labels.set(tenant, labels.has(tenant) ? 'unreadable' : label);
  }
  return labels;
}

// The ids of a tenant's sensitivity labels that a file applies, as
// [MS-OFFCRYPTO] §2.6.3 reads them: the tenant's element in the Sensitivity
// Label Information part decides when there is one; otherwise the tenant's
// enabled label properties do.
export async function appliedSensitivityLabels(zip: JSZip, tenant: string): Promise<string[]> {
  const element = (await labelInformationOf(zip)).get(tenant);
  if (element !== undefined) {
    return element === null || element === 'unreadable' ? [] : [element.id];
  }
  const { properties } = await customPropertiesOf(zip);
  return [...labelIdsOfTenant(properties, tenant)].filter((id) => enabledLabel(properties, id, tenant) !== null);
}

// An xsd:boolean that holds true.
function isTrue(value: string | null): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
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
  const relationships = await xmlPartOf(zip, PACKAGE_RELATIONSHIPS_PART);
  const types = await xmlPartOf(zip, CONTENT_TYPES_PART);
  if (relationships === null || types === null || relationships.documentElement === null || types.documentElement === null) {
    return [];
  }
  const changed: string[] = [];
  const serializer = new XMLSerializer();
  if (!related) {
    appendRelationship(relationships, CUSTOM_PROPERTIES_RELATIONSHIP, part);
    zip.file(PACKAGE_RELATIONSHIPS_PART, serializer.serializeToString(relationships));
    changed.push(PACKAGE_RELATIONSHIPS_PART);
  }
  if (declareContentType(types, `/${part}`, CUSTOM_PROPERTIES_TYPE)) {
    zip.file(CONTENT_TYPES_PART, serializer.serializeToString(types));
    changed.push(CONTENT_TYPES_PART);
  }
  return changed;
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
