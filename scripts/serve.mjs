import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.zip': 'application/zip'
};

function isPublicPath(root, target) {
  const relative = path.relative(root, target);
  return !path.isAbsolute(relative) &&
    relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
    !relative.split(path.sep).some((part) => part.startsWith('.') || part === 'node_modules');
}

export function createPreviewServer(directory = projectRoot) {
  const rootReady = realpath(directory);
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end('Method not allowed');
      return;
    }

    try {
      const root = await rootReady;
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        if (pathname.includes('\0') || pathname.includes('\\')) throw new Error('Invalid path');
      } catch {
        response.writeHead(400);
        response.end('Invalid path');
        return;
      }

      let target = path.resolve(root, `.${pathname}`);
      if (!isPublicPath(root, target)) throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
      if ((await stat(target)).isDirectory()) target = path.join(target, 'index.html');
      target = await realpath(target);
      if (!isPublicPath(root, target)) throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
      const info = await stat(target);
      if (!info.isFile()) throw Object.assign(new Error('Not found'), { code: 'ENOENT' });

      response.writeHead(200, {
        'Content-Type': contentTypes[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'Content-Length': info.size
      });
      if (request.method === 'HEAD') response.end();
      else await pipeline(createReadStream(target), response);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const missing = ['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code);
      response.writeHead(missing ? 404 : 500);
      response.end(missing ? 'Not found' : 'Could not read file');
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT must be an integer between 1 and 65535.');
    process.exitCode = 1;
  } else {
    const server = createPreviewServer();
    server.on('error', (error) => {
      console.error(error.code === 'EADDRINUSE'
        ? `Port ${port} is in use. Set PORT to another port and try again.`
        : `Preview server failed: ${error.message}`);
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`ASCII Portrait Studio: http://127.0.0.1:${port}`);
      console.log('Local preview only. Press Ctrl+C to stop.');
    });
  }
}
