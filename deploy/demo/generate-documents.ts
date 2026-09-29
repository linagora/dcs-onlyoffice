import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Document, Footer, Header, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import JSZip from 'jszip';

interface DemoDocument {
  fileName: string;
  build: () => Document;
}

const OUTPUT_DIRECTORY = path.join(import.meta.dirname, 'documents');
// Files to upload by hand, which the portal does not offer as templates.
const UPLOADS_DIRECTORY = path.join(import.meta.dirname, 'uploads');
// The example label mapping's fictional tenant (deploy/spif), and the
// sensitivity label it pairs with DIFFUSION RESTREINTE released to NATO.
const EXAMPLE_TENANT = '00000000-0000-0000-0000-000000000000';
const RELEASABLE_TO_NATO_LABEL = '10000000-0000-4000-8000-000000000003';

const DEMO_DOCUMENTS: DemoDocument[] = [
  { fileName: 'exercise-northwind.docx', build: buildExerciseNorthwind },
];

function heading(text: string): Paragraph {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(text)] });
}

function paragraph(text: string): Paragraph {
  return new Paragraph({ children: [new TextRun(text)] });
}

function buildExerciseNorthwind(): Document {
  return new Document({
    creator: 'DCS ONLYOFFICE demo',
    title: 'Exercise NORTHWIND 26 - Coordination note',
    description: 'Fictional document for demonstration purposes only',
    sections: [
      {
        headers: { default: new Header({ children: [paragraph('Exercise NORTHWIND 26 - fictional')] }) },
        footers: { default: new Footer({ children: [paragraph('Fictional document for demonstration purposes')] }) },
        children: [
          new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun('Exercise NORTHWIND 26')] }),
          new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('Coordination note')] }),
          new Paragraph({
            children: [
              new TextRun({
                text: 'Entirely fictional document, produced to demonstrate portion labelling in ONLYOFFICE. Any resemblance to real units, places or events is coincidental.',
                italics: true,
              }),
            ],
          }),
          heading('1. Purpose'),
          paragraph(
            'This note sets out the coordination arrangements for Exercise NORTHWIND 26, a fictional multinational command post exercise held over five days.',
          ),
          heading('2. Participants'),
          paragraph(
            'Three fictional brigade headquarters and one logistics group take part. Each provides a liaison officer to the exercise control cell.',
          ),
          heading('3. Schedule'),
          paragraph(
            'Deployment on day 1, command post activities from day 2 to day 4, recovery and after-action review on day 5.',
          ),
          heading('4. Logistics'),
          paragraph(
            'Accommodation, rations and transport are provided by the host nation cell. Requests must reach the control cell ten days before deployment.',
          ),
          heading('5. Points of contact'),
          paragraph('Exercise control cell, fictional extension 0000.'),
        ],
      },
    ],
  });
}

// A fictional workbook, written part by part as SpreadsheetML (ECMA-376
// Part 1 §18): one sheet, a table of supplies, and headers and footers whose
// left and right sections the page marking keeps. Every part's date is
// fixed, so that the file stays the same from one run to the next.
async function buildLogisticsWorkbook(): Promise<Buffer> {
  const date = new Date('2026-09-01T08:00:00Z');
  const rows: (string | number)[][] = [
    ['Exercise NORTHWIND 26 - fictional logistics'],
    [],
    ['Day', 'Unit', 'Supply', 'Quantity'],
    [1, 'Fictional brigade A', 'Rations', 1200],
    [1, 'Fictional brigade B', 'Fuel (litres)', 8000],
    [2, 'Fictional brigade C', 'Rations', 900],
    [2, 'Logistics group', 'Spare parts (crates)', 40],
    [3, 'Exercise control cell', 'Water (litres)', 5000],
  ];
  const strings: string[] = [];
  const stringIndex = (text: string): number => {
    const known = strings.indexOf(text);
    if (known !== -1) {
      return known;
    }
    strings.push(text);
    return strings.length - 1;
  };
  const escape = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const sheetRows = rows
    .map((cells, row) => {
      const values = cells.map((value, column) => {
        const reference = `${String.fromCharCode(65 + column)}${row + 1}`;
        // The title and the table's heading in bold.
        const style = row === 0 || row === 2 ? ' s="1"' : '';
        return typeof value === 'number' ? `<c r="${reference}"${style}><v>${value}</v></c>` : `<c r="${reference}" t="s"${style}><v>${stringIndex(value)}</v></c>`;
      });
      return `<row r="${row + 1}">${values.join('')}</row>`;
    })
    .join('');
  const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const spreadsheetml = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const relationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const packageRelationships = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const parts: [string, string][] = [
    [
      '[Content_Types].xml',
      `${declaration}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    ],
    [
      '_rels/.rels',
      `${declaration}<Relationships xmlns="${packageRelationships}"><Relationship Id="rId1" Type="${relationships}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${relationships}/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    ],
    [
      'docProps/core.xml',
      `${declaration}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Exercise NORTHWIND 26 - Logistics</dc:title><dc:description>Fictional workbook for demonstration purposes only</dc:description><dc:creator>DCS ONLYOFFICE demo</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${date.toISOString().replace(/\.\d{3}Z$/, 'Z')}</dcterms:created></cp:coreProperties>`,
    ],
    ['docProps/app.xml', `${declaration}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>DCS ONLYOFFICE demo</Application></Properties>`],
    [
      'xl/workbook.xml',
      `${declaration}<workbook xmlns="${spreadsheetml}" xmlns:r="${relationships}"><sheets><sheet name="Logistics" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      `${declaration}<Relationships xmlns="${packageRelationships}"><Relationship Id="rId1" Type="${relationships}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${relationships}/styles" Target="styles.xml"/><Relationship Id="rId3" Type="${relationships}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    ],
    [
      'xl/styles.xml',
      `${declaration}<styleSheet xmlns="${spreadsheetml}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`,
    ],
    [
      'xl/worksheets/sheet1.xml',
      `${declaration}<worksheet xmlns="${spreadsheetml}"><cols><col min="1" max="1" width="8" customWidth="1"/><col min="2" max="3" width="26" customWidth="1"/><col min="4" max="4" width="12" customWidth="1"/></cols><sheetData>${sheetRows}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><headerFooter><oddHeader>&amp;LExercise NORTHWIND 26 - fictional</oddHeader><oddFooter>&amp;RFictional workbook</oddFooter></headerFooter></worksheet>`,
    ],
  ];
  // The shared strings, now that the sheet has named them all.
  parts.push([
    'xl/sharedStrings.xml',
    `${declaration}<sst xmlns="${spreadsheetml}" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((text) => `<si><t>${escape(text)}</t></si>`).join('')}</sst>`,
  ]);
  const zip = new JSZip();
  for (const [name, xml] of parts) {
    zip.file(name, xml, { date });
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// A Word file that a Microsoft 365 tenant labelled, as Word writes the label
// ([MS-OI29500] §3.11.2, [MS-OFFCRYPTO] §2.6): in custom properties, and in a
// Sensitivity Label Information part, the example tenant's DIFFUSION
// RESTREINTE released to NATO. The label's date and action id are fixed, so
// that the label stays the same from one run to the next.
async function buildLabelledReport(): Promise<Buffer> {
  const values: [string, string][] = [
    ['Enabled', 'true'],
    ['SetDate', '2026-09-01T08:00:00Z'],
    ['Method', 'Privileged'],
    ['Name', 'DCS-Diffusion-Restreinte-OTAN'],
    ['SiteId', EXAMPLE_TENANT],
    ['ActionId', '20000000-0000-4000-8000-000000000001'],
    ['ContentBits', '0'],
  ];
  const document = new Document({
    creator: 'DCS ONLYOFFICE demo',
    title: 'Exercise NORTHWIND 26 - Logistics report',
    description: 'Fictional document for demonstration purposes only',
    customProperties: values.map(([attribute, value]) => ({ name: `MSIP_Label_${RELEASABLE_TO_NATO_LABEL}_${attribute}`, value })),
    sections: [
      {
        children: [
          new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun('Exercise NORTHWIND 26')] }),
          new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('Logistics report')] }),
          new Paragraph({
            children: [
              new TextRun({
                text: 'Entirely fictional document, labelled in a fictional Microsoft 365 tenant to demonstrate uploads. Any resemblance to real units, places or events is coincidental.',
                italics: true,
              }),
            ],
          }),
          heading('1. Supplies'),
          paragraph('Rations and fuel for five days reach the rear base on day 1.'),
          heading('2. Transport'),
          paragraph('Two fictional convoys a day link the rear base and the command posts.'),
        ],
      },
    ],
  });
  const zip = await JSZip.loadAsync(await Packer.toBuffer(document));
  zip.file(
    'docMetadata/LabelInfo.xml',
    `<?xml version="1.0" encoding="utf-8" standalone="yes"?><clbl:labelList xmlns:clbl="http://schemas.microsoft.com/office/2020/mipLabelMetadata"><clbl:label id="{${RELEASABLE_TO_NATO_LABEL}}" enabled="1" method="Privileged" siteId="{${EXAMPLE_TENANT}}" contentBits="0" removed="0" /></clbl:labelList>`,
  );
  const relationships = (await zip.file('_rels/.rels')?.async('string')) ?? '';
  zip.file(
    '_rels/.rels',
    relationships.replace('</Relationships>', '<Relationship Id="rIdLabelInfo" Type="http://schemas.microsoft.com/office/2020/02/relationships/classificationlabels" Target="docMetadata/LabelInfo.xml"/></Relationships>'),
  );
  const types = (await zip.file('[Content_Types].xml')?.async('string')) ?? '';
  zip.file('[Content_Types].xml', types.replace('</Types>', '<Override PartName="/docMetadata/LabelInfo.xml" ContentType="application/vnd.ms-office.classificationlabels+xml"/></Types>'));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function generateDemoDocuments(): Promise<string[]> {
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const written: string[] = [];
  for (const demoDocument of DEMO_DOCUMENTS) {
    const target = path.join(OUTPUT_DIRECTORY, demoDocument.fileName);
    await writeFile(target, await Packer.toBuffer(demoDocument.build()));
    written.push(target);
  }
  const workbook = path.join(OUTPUT_DIRECTORY, 'exercise-northwind-logistics.xlsx');
  await writeFile(workbook, await buildLogisticsWorkbook());
  written.push(workbook);
  await mkdir(UPLOADS_DIRECTORY, { recursive: true });
  const labelled = path.join(UPLOADS_DIRECTORY, 'fictional-report-labelled-in-microsoft-365.docx');
  await writeFile(labelled, await buildLabelledReport());
  written.push(labelled);
  return written;
}

const writtenFiles = await generateDemoDocuments();
process.stdout.write(`${writtenFiles.map((file) => `wrote ${file}`).join('\n')}\n`);
