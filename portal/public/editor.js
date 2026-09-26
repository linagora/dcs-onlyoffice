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
