import fs from 'fs';
import banner from 'rollup-plugin-banner2';
import replace from '@rollup/plugin-replace';
import typescript from '@rollup/plugin-typescript';

import { string } from './build/strings-plugin.mjs';
import userScriptMetadataBlock from './build/metadata.mjs';
import { extensionManifest } from './build/extension.mjs';
const loadJSON = (path) => JSON.parse(fs.readFileSync(new URL(path, import.meta.url)));
let packageJson = loadJSON('./package.json');

const entry = 'src/index.ts';
const outDir = 'dist';

// One file serves as both the userscript and the extension's content script.
// Userscript manager APIs are looked up at runtime and fall back to plain
// browser equivalents, since a MAIN world content script has the page's real
// window and no menu API.
const runtimeShim = [
  "const gptkPageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;",
  "const gptkMenuCommand = typeof GM_registerMenuCommand === 'function' ? GM_registerMenuCommand : () => {};",
].join('\n');

// Added after replace has run, so the shim's own references survive it
const injectRuntimeShim = () => ({
  name: 'inject-runtime-shim',
  renderChunk(code) {
    return { code: code.replace("'use strict';", `'use strict';\n\n${runtimeShim}`), map: null };
  },
});

const toolkitPlugins = () => [
  // Import HTML as string (must come before TypeScript plugin)
  string({
    include: ['**/*.html'],
  }),

  // Import CSS as string (must come before TypeScript plugin)
  string({
    include: ['**/*.css'],
    transform(code) {
      return code
        .replace(/;\s*\n\s*/g, '; ') // remove line breaks after ;
        .replace(/\{\n */g, '{ ')    // remove line break after {
        .replace(/^\s*\n/gm, '')      // remove empty lines
        .replace(/;\s(\/\*.+\*\/)\n/g, '; $1 ')  // remove line break after comments on properties
        .trim();
    }
  }),

  replace({
    preventAssignment: true,
    __VERSION__: JSON.stringify(packageJson.version),
    __HOMEPAGE__: JSON.stringify(packageJson.homepage)
  }),

  // Route userscript globals through runtimeShim. The default delimiters skip
  // matches followed by a dot, which would miss unsafeWindow.foo.
  replace({
    preventAssignment: true,
    delimiters: ['\\b', '\\b'],
    unsafeWindow: 'gptkPageWindow',
    GM_registerMenuCommand: 'gptkMenuCommand',
  }),

  typescript({
    tsconfig: './tsconfig.json',
  }),
];

const config = [
  {
    input: entry,
    output: {
      file: `${outDir}/${packageJson.main}`,
      format: 'iife',
    },
    plugins: [
      ...toolkitPlugins(),
      injectRuntimeShim(),
      banner(userScriptMetadataBlock),
      extensionManifest(),
    ]
  },
  {
    input: 'src/extension/background.ts',
    output: { file: `${outDir}/background.js`, format: 'iife' },
    plugins: [typescript({ tsconfig: './tsconfig.json' })],
  },
  {
    input: 'src/extension/bridge.ts',
    output: { file: `${outDir}/bridge.js`, format: 'iife' },
    plugins: [typescript({ tsconfig: './tsconfig.json' })],
  },
];

export default config;
