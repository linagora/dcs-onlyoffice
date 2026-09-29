// Opens the ONLYOFFICE editor with the signed configuration embedded in the page.
const configElement = document.getElementById('editor-config');
if (configElement === null || configElement.textContent === null) {
  throw new Error('Missing editor configuration');
}

const config = JSON.parse(configElement.textContent);
config.events = {
  onDocumentReady: () => {
    document.body.dataset.documentReady = 'true';
  },
};

window.docEditor = new window.DocsAPI.DocEditor('editor', config);

// A workbook's screen marking: the strips above and below the editor show its
// document label, first the one the stored file names, then the one the
// labelling panel computes, each time it changes. The panel runs on the
// portal's origin: the page believes messages from its own origin only.
const markingElement = document.getElementById('screen-marking');
if (markingElement !== null && markingElement.textContent !== null) {
  const strips = document.querySelectorAll('.screen-marking');
  const show = (marking) => {
    for (const strip of strips) {
      strip.textContent = marking.text;
      strip.style.backgroundColor = marking.color ?? '#ffffff';
      strip.style.color = readableOn(marking.color);
    }
  };
  const initial = screenMarkingOf(JSON.parse(markingElement.textContent));
  if (initial !== null) {
    show(initial);
  }
  window.addEventListener('message', (event) => {
    const marking = event.origin === window.location.origin ? screenMarkingOf(event.data?.type === 'dcs-screen-marking' ? event.data.marking : null) : null;
    if (marking !== null) {
      show(marking);
    }
  });
}

// A marking's text and colour, as #RRGGBB or null; null for anything else.
function screenMarkingOf(value) {
  const valid =
    typeof value === 'object' &&
    value !== null &&
    typeof value.text === 'string' &&
    (value.color === null || (typeof value.color === 'string' && /^#[0-9a-f]{6}$/i.test(value.color)));
  return valid ? { text: value.text, color: value.color } : null;
}

// Black or white, whichever contrasts more with the colour, by its WCAG
// relative luminance.
function readableOn(color) {
  if (color === null) {
    return '#000000';
  }
  const [red, green, blue] = [1, 3, 5].map((start) => {
    const channel = Number.parseInt(color.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue > 0.179 ? '#000000' : '#ffffff';
}
