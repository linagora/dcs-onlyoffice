import JSZip from 'jszip';

const ZIP_SIGNATURE = Buffer.from('PK\u0003\u0004', 'latin1');

// Where some bytes hold any of the texts, in any of their forms, as UTF-8 or
// UTF-16, including inside zip archives, such as a DOCX or the archive of
// co-editing changes the Document Server writes: the name of each part that
// does. An archive that cannot be opened counts, since it cannot be cleared.
export async function tracesIn(bytes: Buffer, name: string, texts: string[]): Promise<string[]> {
  const needles = texts.flatMap(encodedForms).flatMap((form) => [Buffer.from(form, 'utf8'), Buffer.from(form, 'utf16le')]);
  const search = async (content: Buffer, where: string): Promise<string[]> => {
    const traces = needles.some((needle) => content.includes(needle)) ? [where] : [];
    if (content.subarray(0, ZIP_SIGNATURE.length).equals(ZIP_SIGNATURE)) {
      const zip = await JSZip.loadAsync(content).catch(() => null);
      if (zip === null) {
        return [...traces, `${where} (an archive that cannot be opened)`];
      }
      for (const entry of Object.values(zip.files)) {
        if (!entry.dir) {
          traces.push(...(await search(await entry.async('nodebuffer'), `${where} > ${entry.name}`)));
        }
      }
    }
    return traces;
  };
  return search(bytes, name);
}

// The forms a text could take on its way to ONLYOFFICE. It could be written
// as it is, or in base64 as the plugin writes bytes into XML; the editor and
// the Document Server could then carry it as it is, URL-encoded, or in base64
// of its UTF-8 or UTF-16 bytes, as the editor sends a custom XML part's
// content.
function encodedForms(text: string): string[] {
  const written = [text, ...base64Forms(Buffer.from(text, 'utf8'))];
  const carried = written.flatMap((form) => [
    form,
    encodeURIComponent(form),
    ...base64Forms(Buffer.from(form, 'utf8')),
    ...base64Forms(Buffer.from(form, 'utf16le')),
  ]);
  return [...new Set(carried.flatMap((form) => [form, form.replaceAll('+', '-').replaceAll('/', '_')]))];
}

// The base64 of some bytes wherever they start within the encoded data: at
// each of the three alignments, only the characters their bits alone decide.
function base64Forms(bytes: Buffer): string[] {
  return [0, 1, 2].map((offset) => {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString('base64');
    return encoded.slice(Math.ceil((offset * 8) / 6), Math.floor(((offset + bytes.length) * 8) / 6));
  });
}
