import { render } from 'preact';
import { language } from './messages.ts';
import { whenPluginReady } from './onlyoffice.ts';
import { Panel } from './Panel.tsx';
import './panel.css';

const pluginReady = whenPluginReady();

// Screen readers pronounce the panel in the language of its texts.
document.documentElement.lang = language;

const root = document.getElementById('app');
if (root === null) {
  throw new Error('The panel page has no #app element');
}
render(<Panel pluginReady={pluginReady} />, root);
