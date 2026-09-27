import { render } from 'preact';
import { whenPluginReady } from './onlyoffice.ts';
import { Panel } from './Panel.tsx';
import './panel.css';

const pluginReady = whenPluginReady();

const root = document.getElementById('app');
if (root === null) {
  throw new Error('The panel page has no #app element');
}
render(<Panel pluginReady={pluginReady} />, root);
