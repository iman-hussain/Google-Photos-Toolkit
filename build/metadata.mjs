import fs from 'fs';
const loadJSON = (path) => JSON.parse(fs.readFileSync(new URL(path, import.meta.url)));


//
// Generate metadata block with information from package.json
// https://sourceforge.net/p/greasemonkey/wiki/Metadata_Block/
// @author victornpb
//

function generateComment(manifest) {
  const largestKey = Object.keys(manifest).reduce((a, b) => a.length > b.length ? a : b).length;
  const generateLine = (key, value) => `// @${key.padEnd(largestKey, ' ')} ${value}`;
  const lines = Object.entries(manifest).map(([key, value]) => {
    if (Array.isArray(value))
      return value.map(subVal => generateLine(key, subVal)).join('\n');
    return generateLine(key, value);
  }).join('\n');
  // MIT requires the copyright and permission notice in every copy
  const licence = fs.readFileSync(new URL('../LICENSE', import.meta.url), 'utf8').trim();
  return [
    '// ==UserScript==',
    lines,
    '// ==/UserScript==',
    '',
    '/*',
    licence,
    '*/',
    '',
  ].join('\n');
}

export default function userScriptMetadataBlock() {
  const pkg = loadJSON('../package.json');

  const metadata = {
    name: pkg.nameFull,
    description: pkg.description,
    // Userscript managers compare dotted numbers, so 3.3.0-swipe.1 -> 3.3.0.1
    version: pkg.version.replace('-swipe.', '.'),
    author: pkg.author,
    homepageURL: pkg.homepage,
    supportURL: pkg.bugs.url,
    match: pkg.userScript.match,
    license: pkg.license,
    ...pkg.userScript,
  };

  return generateComment(metadata);
}