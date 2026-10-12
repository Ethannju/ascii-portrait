import assert from 'node:assert/strict';
import { request } from 'node:http';
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPreviewServer } from '../scripts/serve.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function startServer(root) {
  const server = createPreviewServer(root);
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  return {
    server,
    port: server.address().port,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

// Send the literal request path, rather than letting fetch normalize traversal
// attempts before they reach the server under test.
function httpCall(port, target, method = 'GET') {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, path: target, method, agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        bytes: Buffer.concat(chunks),
        text: Buffer.concat(chunks).toString('utf8')
      }));
    });
    outgoing.on('error', reject);
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error(`HTTP request timed out: ${method} ${target}`)));
    outgoing.end();
  });
}

function assertSafetyHeaders(response) {
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
}

await test('preview server HTTP, filesystem boundaries, and static release links', async (suite) => {
  // All potentially sensitive test files and symlinks live in an isolated,
  // uniquely named temporary tree, never in the user's public source directory.
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ascii-portrait-server-'));
  const fixtureRoot = path.join(temporaryRoot, 'site');
  const servers = [];
  try {
    await mkdir(path.join(fixtureRoot, 'nested'), { recursive: true });
    await mkdir(path.join(fixtureRoot, '.git'), { recursive: true });
    await mkdir(path.join(fixtureRoot, 'node_modules', 'sample'), { recursive: true });
    await mkdir(path.join(fixtureRoot, 'no-index'), { recursive: true });
    await mkdir(path.join(temporaryRoot, 'outside-directory'), { recursive: true });
    const secret = 'SERVER_TEST_SECRET_MUST_NEVER_BE_RETURNED';
    const fixtureFiles = [
      ['index.html', '<!doctype html><title>Server fixture</title>'],
      ['nested/index.html', '<!doctype html><title>Nested fixture</title>'],
      ['app.js', 'globalThis.fixtureReady = true;'],
      ['styles.css', 'body { color: black; }'],
      ['data.json', '{"ok":true}'],
      ['encoded name.txt', 'A filename containing a space'],
      ['.env', secret],
      ['.env.local', secret],
      ['.git/config', secret],
      ['nested/.hidden', secret],
      ['node_modules/sample/index.js', secret]
    ];
    for (const [name, contents] of fixtureFiles) await writeFile(path.join(fixtureRoot, name), contents);
    await writeFile(path.join(temporaryRoot, 'outside.txt'), secret);
    await writeFile(path.join(temporaryRoot, 'outside-directory', 'index.html'), secret);
    await symlink(path.join(temporaryRoot, 'outside.txt'), path.join(fixtureRoot, 'outside-file-link'));
    await symlink(path.join(temporaryRoot, 'outside-directory'), path.join(fixtureRoot, 'outside-directory-link'));
    await symlink(path.join(fixtureRoot, '.env'), path.join(fixtureRoot, 'hidden-file-link'));
    await symlink(path.join(fixtureRoot, 'app.js'), path.join(fixtureRoot, 'inside-file-link.js'));

    const fixtureServer = await startServer(fixtureRoot);
    servers.push(fixtureServer);
    const call = (target, method) => httpCall(fixtureServer.port, target, method);

    await suite.test('GET and HEAD return matching metadata, MIME types, and exact file bytes', async () => {
      for (const [url, filename, type] of [
        ['/', 'index.html', 'text/html; charset=utf-8'],
        ['/index.html?cache=ignored', 'index.html', 'text/html; charset=utf-8'],
        ['/nested/', 'nested/index.html', 'text/html; charset=utf-8'],
        ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
        ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
        ['/data.json', 'data.json', 'application/json; charset=utf-8'],
        ['/encoded%20name.txt', 'encoded name.txt', 'application/octet-stream'],
        ['/inside-file-link.js', 'app.js', 'text/javascript; charset=utf-8']
      ]) {
        const expected = await readFile(path.join(fixtureRoot, filename));
        const get = await call(url);
        const head = await call(url, 'HEAD');
        for (const response of [get, head]) {
          assert.equal(response.status, 200, `${url} should be accessible`);
          assert.equal(response.headers['content-type'], type);
          assert.equal(Number(response.headers['content-length']), expected.length);
          assertSafetyHeaders(response);
        }
        assert.deepEqual(get.bytes, expected);
        assert.equal(head.bytes.length, 0, 'HEAD must not return a response body');
      }
    });

    await suite.test('missing files and directories without an index return 404 without listing contents', async () => {
      for (const target of ['/missing', '/no-index/', '/app.js/child', '/missing?query=1']) {
        const response = await call(target);
        assert.equal(response.status, 404, target);
        assert.equal(response.text, 'Not found');
        assertSafetyHeaders(response);
      }
      const head = await call('/missing', 'HEAD');
      assert.equal(head.status, 404);
      assert.equal(head.bytes.length, 0);
    });

    await suite.test('unsupported methods return 405 and a precise Allow header', async () => {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const response = await call('/', method);
        assert.equal(response.status, 405, method);
        assert.equal(response.headers.allow, 'GET, HEAD');
        assert.equal(response.text, 'Method not allowed');
        assertSafetyHeaders(response);
      }
    });

    await suite.test('malformed escapes, NULs, and encoded backslashes return 400', async () => {
      for (const target of ['/%', '/%GG', '/%E0%A4%A', '/%00', '/file%00.txt', '/bad%5cname']) {
        const response = await call(target);
        assert.equal(response.status, 400, target);
        assert.equal(response.text, 'Invalid path');
        assertSafetyHeaders(response);
      }
    });

    await suite.test('dotfiles, Git metadata, environment files, and dependency trees stay private', async () => {
      for (const target of ['/.env', '/.env.local', '/%2eenv', '/.git/config', '/%2egit%2fconfig',
        '/nested/.hidden', '/nested/%2ehidden', '/node_modules/sample/index.js']) {
        const response = await call(target);
        assert.equal(response.status, 404, target);
        assert.equal(response.text, 'Not found');
        assert.ok(!response.text.includes(secret));
        assertSafetyHeaders(response);
      }
    });

    await suite.test('literal and encoded traversal cannot escape the served root', async () => {
      for (const target of ['/../outside.txt', '/../outside-directory/', '/..%2foutside.txt',
        '/%2e%2e%2foutside.txt', '/nested/..%2f..%2foutside.txt',
        '/%252e%252e%252foutside.txt', '/nested/../.env', '/bad\\name', '/..\\outside.txt']) {
        const response = await call(target);
        assert.equal(response.status, 404, target);
        assert.ok(!response.text.includes(secret));
        assertSafetyHeaders(response);
      }
      assert.equal((await call('/%2e%2e%5coutside.txt')).status, 400);
    });

    await suite.test('symlinks to outside files, outside directories, and protected files are blocked', async () => {
      for (const target of ['/outside-file-link', '/outside-directory-link/', '/outside-directory-link/index.html', '/hidden-file-link']) {
        const response = await call(target);
        assert.equal(response.status, 404, target);
        assert.ok(!response.text.includes(secret));
        assertSafetyHeaders(response);
      }
    });

    const html = await readFile(path.join(projectRoot, 'index.html'), 'utf8');
    const selectSource = await readFile(path.join(projectRoot, 'studio-select.js'), 'utf8');
    const css = await readFile(path.join(projectRoot, 'studio-select.css'), 'utf8');
    const referencedResources = new Set([
      ...[...html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)].map((match) => match[1]),
      ...[...(html + selectSource).matchAll(/["'](\.\/assets\/[^"']+)["']/g)].map((match) => match[1]),
      ...[...css.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/g)].map((match) => match[1])
    ].filter((value) => !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value)));
    assert.ok(referencedResources.has('./motion-export.js'));
    assert.ok(referencedResources.has('./studio-select.js'));
    assert.ok(referencedResources.has('./studio-select.css'));
    assert.ok(referencedResources.has('./assets/demo-portrait.jpg'));
    assert.ok(referencedResources.has('./assets/demo-astronaut.jpg'));
    assert.ok(referencedResources.has('./assets/demo-mecha.jpg'));

    const projectServer = await startServer(projectRoot);
    servers.push(projectServer);
    await suite.test('the real project serves every referenced local script, stylesheet, and demo with exact bytes', async () => {
      assert.equal((await httpCall(projectServer.port, '/')).status, 200);
      for (const resource of referencedResources) {
        const url = new URL(resource, 'http://example.test/index.html');
        const response = await httpCall(projectServer.port, url.pathname);
        assert.equal(response.status, 200, resource);
        assert.deepEqual(response.bytes, await readFile(path.join(projectRoot, decodeURIComponent(url.pathname))));
        assertSafetyHeaders(response);
        if (/\.js$/.test(url.pathname)) assert.match(response.headers['content-type'], /^text\/javascript/);
        if (/\.css$/.test(url.pathname)) assert.match(response.headers['content-type'], /^text\/css/);
        if (/\.jpg$/.test(url.pathname)) assert.equal(response.headers['content-type'], 'image/jpeg');
      }
    });

    const staticFiles = ['index.html', 'motion-export.js', 'studio-select.js', 'studio-select.css',
      'LICENSE', 'ASSET-LICENSE.md', 'assets'];
    const deploymentRoot = path.join(temporaryRoot, 'deployment');
    const nestedRelease = path.join(deploymentRoot, 'repository');
    await mkdir(nestedRelease, { recursive: true });
    for (const file of staticFiles) {
      await cp(path.join(projectRoot, file), path.join(nestedRelease, file), { recursive: true });
    }
    const deploymentServer = await startServer(deploymentRoot);
    servers.push(deploymentServer);
    await suite.test('a static copy also resolves resources beneath a repository-style URL prefix', async () => {
      assert.equal((await httpCall(deploymentServer.port, '/repository/')).status, 200);
      for (const resource of referencedResources) {
        const url = new URL(resource, 'http://example.test/repository/index.html');
        assert.ok(url.pathname.startsWith('/repository/'), `${resource} escapes the deployment prefix`);
        assert.equal((await httpCall(deploymentServer.port, url.pathname)).status, 200, resource);
      }
      for (const notice of ['LICENSE', 'ASSET-LICENSE.md', 'assets/PROVENANCE.md']) {
        assert.equal((await httpCall(deploymentServer.port, `/repository/${notice}`)).status, 200, notice);
      }
    });

    await suite.test('READMEs and asset notices have resolvable local links and images', async () => {
      for (const filename of ['README.md', 'README.zh-CN.md', 'README.ja.md', 'README.es.md',
        'ASSET-LICENSE.md', 'assets/PROVENANCE.md']) {
        const source = await readFile(path.join(projectRoot, filename), 'utf8');
        const links = [...source.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g),
          ...source.matchAll(/<img\s[^>]*src="([^"]+)"/g)].map((match) => match[1]);
        for (const link of links) {
          if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(link)) continue;
          const target = path.resolve(path.dirname(path.join(projectRoot, filename)), decodeURIComponent(link.split(/[?#]/)[0]));
          const relative = path.relative(projectRoot, target);
          assert.ok(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `${filename}: ${link}`);
          await access(target);
          assert.equal((await httpCall(projectServer.port, `/${relative.split(path.sep).map(encodeURIComponent).join('/')}`)).status, 200,
            `${filename}: ${link}`);
        }
      }
    });
  } finally {
    try {
      await Promise.all(servers.map((server) => server.close()));
    } finally {
      // Remove only the exact unique fixture directory allocated by this test.
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
});
