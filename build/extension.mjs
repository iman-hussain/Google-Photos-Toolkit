import fs from 'fs';
const loadJSON = (path) => JSON.parse(fs.readFileSync(new URL(path, import.meta.url)));

//
// Emits manifest.json and the icon next to the extension bundles
//

export function extensionManifest() {
  return {
    name: 'extension-manifest',
    generateBundle() {
      const pkg = loadJSON('../package.json');
      const match = ['https://photos.google.com/*'];
      const manifest = {
        manifest_version: 3,
        name: pkg.nameFull,
        description: pkg.description,
        // Chrome wants up to four dotted integers, so 3.3.0-swipe.1 -> 3.3.0.1
        version: pkg.version.replace('-swipe.', '.'),
        version_name: pkg.version,
        homepage_url: pkg.homepage,
        icons: { 128: 'icon.png' },
        action: { default_title: 'Open Swipe mode', default_icon: { 128: 'icon.png' } },
        background: { service_worker: 'background.js' },
        content_scripts: [
          // The toolkit reads WIZ_global_data from the page, so it must run in the main world
          { matches: match, js: ['gptk.js'], run_at: 'document_end', world: 'MAIN' },
          { matches: match, js: ['bridge.js'], run_at: 'document_end' },
        ],
      };
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: JSON.stringify(manifest, null, 2) });
      this.emitFile({ type: 'asset', fileName: 'icon.png', source: fs.readFileSync(new URL('../media/icon.png', import.meta.url)) });
    },
  };
}
