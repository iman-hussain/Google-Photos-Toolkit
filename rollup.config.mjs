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
const extensionDir = 'dist/extension';

// Userscript manager APIs the toolkit uses, stubbed for the extension build.
// In a MAIN world content script the page's window is the real one.
const extensionShim = [
  'const unsafeWindow = window;',
  'const GM_registerMenuCommand = () => {};',
].join('\n');

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

  typescript({
    tsconfig: './tsconfig.json',
  }),
];

const config = [
  {
    input: entry,
    output: [
      {
        file: packageJson.main,
        format: 'iife',
      },
    ],
    plugins: [
      ...toolkitPlugins(),
      banner(userScriptMetadataBlock),
    ]
  },
  {
    input: entry,
    output: {
      file: `${extensionDir}/gptk.js`,
      format: 'iife',
      intro: extensionShim,
    },
    plugins: [
      ...toolkitPlugins(),
      extensionManifest(),
    ]
  },
  {
    input: 'src/extension/background.ts',
    output: { file: `${extensionDir}/background.js`, format: 'iife' },
    plugins: [typescript({ tsconfig: './tsconfig.json' })],
  },
  {
    input: 'src/extension/bridge.ts',
    output: { file: `${extensionDir}/bridge.js`, format: 'iife' },
    plugins: [typescript({ tsconfig: './tsconfig.json' })],
  },
];

export default config;
