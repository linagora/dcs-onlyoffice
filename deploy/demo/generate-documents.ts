import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';

interface DemoDocument {
  fileName: string;
  build: () => Document;
}

const OUTPUT_DIRECTORY = path.join(import.meta.dirname, 'documents');

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

async function generateDemoDocuments(): Promise<string[]> {
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const written: string[] = [];
  for (const demoDocument of DEMO_DOCUMENTS) {
    const target = path.join(OUTPUT_DIRECTORY, demoDocument.fileName);
    await writeFile(target, await Packer.toBuffer(demoDocument.build()));
    written.push(target);
  }
  return written;
}

const writtenFiles = await generateDemoDocuments();
process.stdout.write(`${writtenFiles.map((file) => `wrote ${file}`).join('\n')}\n`);
