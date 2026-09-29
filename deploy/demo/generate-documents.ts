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
  await mkdir(UPLOADS_DIRECTORY, { recursive: true });
  const labelled = path.join(UPLOADS_DIRECTORY, 'fictional-report-labelled-in-microsoft-365.docx');
  await writeFile(labelled, await buildLabelledReport());
  written.push(labelled);
  return written;
}

const writtenFiles = await generateDemoDocuments();
process.stdout.write(`${writtenFiles.map((file) => `wrote ${file}`).join('\n')}\n`);
