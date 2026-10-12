import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(path.join(root, file), 'utf8');

for (const required of ['README.md', 'README.zh-CN.md', 'README.ja.md', 'README.es.md', 'LICENSE', 'ASSET-LICENSE.md',
  '.gitignore', 'assets/PROVENANCE.md']) {
  await access(path.join(root, required));
}

// This is a clean public source tree, not a copy of the legacy portrait package.
// Add new release files deliberately so an accidental photo or archive cannot
// silently become part of the public directory. Git/dependency internals are not
// release inputs and are intentionally not traversed.
const releaseFiles = new Set([
  '.gitignore', 'ASSET-LICENSE.md', 'LICENSE', 'README.md', 'README.zh-CN.md', 'README.ja.md', 'README.es.md',
  'index.html', 'motion-export.js', 'studio-select.js', 'studio-select.css', 'package.json',
  'scripts/check.mjs', 'scripts/serve.mjs',
  'tests/editor-harness.mjs', 'tests/runtime-regressions.mjs',
  'tests/motion-export.mjs', 'tests/demo-regressions.mjs', 'tests/select-regressions.mjs',
  'tests/server-regressions.mjs',
  'assets/demo-portrait.jpg', 'assets/demo-astronaut.jpg', 'assets/demo-mecha.jpg',
  'assets/PROVENANCE.md',
  'media/ascii-portrait-demo.mp4', 'media/preview.webp',
  'media/examples/portrait-ascii.webp', 'media/examples/astronaut-ascii.webp',
  'media/examples/mecha-ascii.webp'
]);
async function checkReleaseDirectory(directory = root, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.DS_Store'].includes(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert.equal(entry.isSymbolicLink(), false, `Release contains a symlink: ${relative}`);
    assert.ok(!['package', 'private', 'private-assets', 'portraits'].includes(entry.name),
      `Private or legacy asset directory must not be published: ${relative}`);
    assert.ok(!/^portrait-preset\.(?:json|js)$/i.test(entry.name),
      `Personal portrait presets must not be published: ${relative}`);
    assert.ok(!/\.zip$/i.test(entry.name), `Unreviewed archive in release: ${relative}`);
    if (entry.isDirectory()) {
      assert.ok([...releaseFiles].some((file) => file.startsWith(`${relative}/`)),
        `Unexpected release directory: ${relative}`);
      await checkReleaseDirectory(path.join(directory, entry.name), relative);
    } else {
      assert.ok(entry.isFile() && releaseFiles.has(relative),
        `Unexpected release file; review before allowing publication: ${relative}`);
    }
  }
}
await checkReleaseDirectory();
for (const file of releaseFiles) await access(path.join(root, file));

// README showcase media: not loaded by the Studio. Keep the video under GitHub's
// 50 MB large-file warning so the repository stays easy to clone.
const showcaseMedia = [
  ['media/ascii-portrait-demo.mp4', 50, (bytes) => bytes.subarray(4, 8).toString() === 'ftyp', 'an MP4'],
  ...['media/preview.webp', 'media/examples/portrait-ascii.webp',
    'media/examples/astronaut-ascii.webp', 'media/examples/mecha-ascii.webp'].map((file) => [file, 2,
    (bytes) => bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP',
    'a WebP image'])
];
for (const [file, maximumMegabytes, matchesFormat, format] of showcaseMedia) {
  const mediaBytes = await readFile(path.join(root, file));
  assert.ok(mediaBytes.length > 0 && mediaBytes.length < maximumMegabytes * 1024 * 1024,
    `${file} should stay below ${maximumMegabytes} MB.`);
  assert.ok(matchesFormat(mediaBytes), `${file} must be ${format}.`);
}
// Translations must stay in step with the English README: the same video, links,
// and example images, plus a switcher that reaches every other language.
const readmeFiles = ['README.md', 'README.zh-CN.md', 'README.ja.md', 'README.es.md'];
const readmeFacts = async (file) => {
  const source = await read(file);
  assert.match(source, /\]\(\.\/media\/ascii-portrait-demo\.mp4\)/, `${file} must link the full-quality demo video.`);
  for (const other of readmeFiles.filter((candidate) => candidate !== file)) {
    assert.ok(source.includes(`](./${other})`), `${file} must link to ${other} in its language switcher.`);
  }
  return JSON.stringify({
    images: [...source.matchAll(/<img\s[^>]*src="([^"]+)"/g)].map((match) => match[1]),
    urls: [...new Set(source.match(/https:\/\/[^\s)"]+/g))].sort()
  });
};
const englishReadme = await readmeFacts('README.md');
for (const file of readmeFiles.slice(1)) {
  assert.equal(await readmeFacts(file), englishReadme, `${file} is out of step with README.md (images or URLs differ).`);
}

const reviewedDemos = {
  'demo-portrait.jpg': '757d4b772d42e5818545c9204ca28eba37c6879034a752a716ac38088ebfe9f3',
  'demo-astronaut.jpg': 'd60ebaef6d31fca3ea0f2b3aa5afd4f208bc6255e33aa05112ccf42a2405e640',
  'demo-mecha.jpg': 'ce78d3b5f8394bee78df52b4ad2c48cffc8ce642895bd87a8cf5b8cc3e5c8409'
};
for (const [file, fingerprint] of Object.entries(reviewedDemos)) {
  const demoBytes = await readFile(path.join(root, 'assets', file));
  assert.ok(demoBytes.length > 0 && demoBytes.length < 2 * 1024 * 1024,
    `${file} should be a bounded, optimized image.`);
  assert.equal(demoBytes.subarray(0, 3).toString('hex'), 'ffd8ff', `${file} must be a JPEG.`);
  assert.equal(createHash('sha256').update(demoBytes).digest('hex'), fingerprint,
    `${file} changed. Verify its provenance before updating this fingerprint.`);
}

const editorHtml = await read('index.html');
const inlineScripts = [...editorHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1]).filter((source) => source.trim());
for (const source of inlineScripts) new Function(source);
assert.ok(inlineScripts.length >= 2, 'Editor should contain its bootstrap and application scripts.');
const motionSource = await read('motion-export.js');
new Function(motionSource);
const selectSource = await read('studio-select.js');
new Function(selectSource);
assert.match(editorHtml, /<script src="\.\/studio-select\.js"><\/script>/);
assert.match(editorHtml, /<link rel="stylesheet" href="\.\/studio-select\.css"\s*\/>/);
for (const [name, source] of [['index.html', editorHtml], ['motion-export.js', motionSource], ['studio-select.js', selectSource]]) {
  assert.doesNotMatch(source, /data:image\//i, `${name} must not contain embedded image payloads.`);
  assert.doesNotMatch(source, /package\/ascii-portrait-asset/, `${name} must not load the private package.`);
  assert.doesNotMatch(source, /\/Users\//, `${name} must not expose local source paths.`);
}

for (const url of editorHtml.match(/https:\/\/cdn\.jsdelivr\.net\/npm\/[^'"\s]+/g) || []) {
  assert.match(url, /@[0-9]+\.[0-9]+\.[0-9]+/, `Unpinned CDN dependency: ${url}`);
}
assert.match(editorHtml, /integrity: 'sha384-/);
assert.match(editorHtml, /<html lang="en">/);
assert.match(editorHtml, /id="languageSelect"/);
assert.match(editorHtml, /<option value="en" selected>English<\/option>/);
assert.match(editorHtml, /<option value="zh">中文<\/option>/);
assert.match(editorHtml, /const translations = \{/);
assert.match(editorHtml, /applyLanguage\(getInitialLanguage\(\), \{ persist: false \}\)/);
const translationSource = editorHtml.match(
  /const translations = (\{[\s\S]*?\});\n(?:\s*\/\/[^\n]*\n)*\s+const languageStorageKey/
);
assert.ok(translationSource, 'Translation dictionaries could not be parsed.');
const translationContext = {};
vm.runInNewContext(`translations = ${translationSource[1]}`, translationContext);
assert.deepEqual(
  Object.keys(translationContext.translations.en).sort(),
  Object.keys(translationContext.translations.zh).sort(),
  'English and Chinese must expose the same translation keys.'
);
const referencedTranslationKeys = new Set([
  ...[...editorHtml.matchAll(/data-i18n(?:-aria|-title)?="([A-Za-z0-9]+)"/g)].map((match) => match[1]),
  ...[...editorHtml.matchAll(/(?<![A-Za-z0-9_$])(?:t|setStatus|updateProcessor|hideProcessor)\('([A-Za-z0-9]+)'/g)]
    .map((match) => match[1]),
  ...[...editorHtml.matchAll(/labelKey: '([A-Za-z0-9]+)'/g)].map((match) => match[1])
]);
for (const key of referencedTranslationKeys) {
  assert.ok(translationContext.translations.en[key], `Missing English translation: ${key}`);
  assert.ok(translationContext.translations.zh[key], `Missing Chinese translation: ${key}`);
}
const editorIds = [...editorHtml.matchAll(/\sid="([A-Za-z][A-Za-z0-9_-]*)"/g)]
  .map((match) => match[1]);
assert.equal(new Set(editorIds).size, editorIds.length, 'Editor HTML contains duplicate element IDs.');
for (const [, queriedId] of editorHtml.matchAll(/querySelector\('#([A-Za-z][A-Za-z0-9_-]*)'\)/g)) {
  assert.ok(editorIds.includes(queriedId), `JavaScript queries a missing editor element: #${queriedId}`);
}
assert.match(editorHtml, /state\.frozenPreset && state\.samples\.length/);
assert.match(editorHtml, /baseBreathing[^\n]+effectScale \* breathEnabled/);
assert.doesNotMatch(editorHtml, /data-i18n="motionBreath"/);
assert.doesNotMatch(editorHtml, /labelKey: 'motionBreath'/);
assert.match(editorHtml, /preset\.version !== 1 && preset\.version !== 2/);
for (const removed of ['ASSET_PRESET_BOOTSTRAP', '__ASCII_PORTRAIT_PRESET__',
  'loadStoredAssetPreset', 'createAssetPreset', 'getExportSourceCanvas',
  'loadDefaultAssetPreset', 'statusFrozen', 'statusDownloadedStorageBlocked']) {
  assert.ok(!editorHtml.includes(removed), `Removed development feature returned: ${removed}`);
}
assert.doesNotMatch(editorHtml, /loadAssetPresetUrl\(['"]\.\/portrait-preset\.json['"]\)/);
assert.match(editorHtml, /\[0, 0, 1, 2, 3\]\[preset\.motionIndex\]/);
assert.match(editorHtml, /let portraitSegmenterPromise = null/);
assert.match(editorHtml, /const maxSide = 576/);
assert.doesNotMatch(editorHtml, /loaderAscii\.appendChild/);
assert.match(editorHtml, /exportCanvas\.toBlob/);
assert.doesNotMatch(editorHtml, /shouldAnimateWarp/);

await import('../tests/runtime-regressions.mjs');
await import('../tests/motion-export.mjs');
await import('../tests/demo-regressions.mjs');
await import('../tests/select-regressions.mjs');
// node:test finalizes its exit status after imported modules finish. Run it in
// a child so a failed HTTP suite cannot be followed by a misleading success line.
execFileSync(process.execPath, [path.join(root, 'tests/server-regressions.mjs')], { stdio: 'inherit' });
console.log('ASCII Portrait Studio public release checks passed.');
