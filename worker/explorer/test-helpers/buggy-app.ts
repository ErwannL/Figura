import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * A tiny local web app for the explorer's integration test. `healthy: false` plants the defects
 * every detector must find; `healthy: true` serves the same screens without them (a detector that
 * cannot fail proves nothing). Both carry a "Delete account" button and an external link that the
 * explorer must never activate: the server counts the hits it would cause.
 */
export async function buggyApp(o: { healthy: boolean }) {
  const hits = { deleteAccount: 0, logout: 0, pages: [] as string[] };
  const bad = !o.healthy;
  // `?solo` drops the navigation: a detector test then stays on the one screen it targets.
  let nav = true;
  const page = (title: string, body: string, extraHead = '') =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>${extraHead}
<style>body{font-family:sans-serif;margin:8px}button,a,input,select,[role=button]{display:inline-block;min-width:44px;min-height:44px;margin:4px}
dialog{position:fixed;inset:0}.wide{width:${bad ? 1400 : 300}px;height:20px;background:#ccc}</style></head>
<body>${nav ? '' : '<!--'}<nav><a href="/">Home</a><a href="/boards">Boards</a><a href="/wide">Layout</a><a href="${bad ? '/missing' : '/boards'}">Archive</a><a href="/extras">Extras</a><a href="${bad ? '/board/999' : '/boards'}">Old board</a><a href="https://example.com/help">Help</a></nav>${nav ? '' : '-->'}<main>${body}</main>
<script>
document.getElementById('boom')?.addEventListener('click', () => { ${bad ? "throw new Error('Boom handler exploded')" : "document.getElementById('out').textContent = 'fine'"}; });
document.getElementById('load')?.addEventListener('click', () => fetch('${bad ? '/api/fail' : '/api/ok'}').then(r => { document.getElementById('out').textContent = String(r.status); }));
document.getElementById('del')?.addEventListener('click', () => fetch('/api/delete-account', { method: 'POST' }));
document.getElementById('away')?.addEventListener('click', () => { location.href = 'http://elsewhere.invalid/phish'; });
document.getElementById('save')?.addEventListener('click', (e) => { e.preventDefault(); const v = document.getElementById('title').value; const li = document.createElement('li'); ${bad ? 'li.innerHTML = v' : 'li.textContent = v'}; document.getElementById('list').append(li); });
document.getElementById('slow')?.addEventListener('click', () => fetch('/api/slow').then(r => r.text()));
document.getElementById('me')?.addEventListener('click', () => fetch('${bad ? '/api/me-expired' : '/api/ok'}'));
document.getElementById('pro')?.addEventListener('click', () => fetch('/api/pro'));
document.getElementById('log')?.addEventListener('click', () => ${bad ? "console.error('custom failure')" : "console.info('all good')"});
document.getElementById('trap')?.addEventListener('click', () => { document.getElementById('modal').hidden = false; });
document.getElementById('close')?.addEventListener('click', () => { document.getElementById('modal').hidden = true; });
</script></body></html>`;
  const routes = routesFor(bad, page);
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url as string, 'http://x');
    const path = url.pathname;
    nav = !url.searchParams.has('solo');
    if (path === '/api/slow') await new Promise((r) => setTimeout(r, bad ? 1500 : 5));
    hits.pages.push(path);
    if (path === '/api/delete-account') hits.deleteAccount += 1;
    const r = routes[path];
    const [status, type, body] = r
      ? r()
      : [404, 'text/html', page('Not found', '<h1>Page not found</h1>')];
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  };
  const server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type Route = () => [number, string, string];

function routesFor(
  bad: boolean,
  page: (title: string, body: string) => string,
): Record<string, Route> {
  return {
    '/': () => [
      200,
      'text/html',
      page(
        'Home',
        `<h1>Home</h1><button id="boom">Boom</button><button id="load">Load data</button><button id="del">Delete account</button><button id="away">Partner offer</button><p id="out"></p>`,
      ),
    ],
    '/boards': () => [
      200,
      'text/html',
      page(
        'Boards',
        `<h1>Boards</h1><p>${bad ? 'boards.empty_state.title' : 'No board yet'}</p><form><label for="title">Title</label><input id="title"><textarea aria-label="Notes"></textarea><button id="save">Save</button></form><ul id="list"></ul>`,
      ),
    ],
    '/wide': () => [200, 'text/html', page('Layout', `<h1>Layout</h1><div class="wide"></div>`)],
    '/extras': () => [
      200,
      'text/html',
      page(
        'Extras',
        `<h1>Extras</h1><input aria-label="Filter"><button id="slow">Slow</button><button id="me">Who am I</button><button id="pro">Pro feature</button><button id="log">Log</button>
<label for="sort">Sort</label><select id="sort"><option>Name</option><option>Date</option></select><select aria-label="Empty"></select>
<div role="button" draggable="true" tabindex="0">Card one</div><button id="trap">Open panel</button>
<div id="modal" role="dialog" aria-modal="true" hidden style="position:fixed;inset:0;background:#fff"><p>Panel</p><button>Stay</button>${bad ? '' : '<button id="close">Close</button>'}</div>`,
      ),
    ],
    // A single-page app answers 200 and renders its own NotFound screen.
    '/board/999': () => [200, 'text/html', page('Orqea', '<h1>Page not found</h1>')],
    // A control under an invisible overlay: clicking it fails, as it would for a person.
    '/covered': () => [
      200,
      'text/html',
      page(
        'Covered',
        '<span style="position:relative;display:inline-block"><button>Covered</button><span style="position:absolute;inset:0;background:rgba(0,0,0,.01)"></span></span>',
      ),
    ],
    '/api/slow': () => [200, 'text/plain', 'ok'],
    '/api/me-expired': () => [401, 'application/json', '{"message":"expired"}'],
    '/api/pro': () => [402, 'application/json', '{"code":"FEATURE_LOCKED","upgrade":true}'],
    '/api/fail': () => [500, 'application/json', '{"error":"boom"}'],
    '/api/ok': () => [200, 'application/json', '{"ok":true}'],
  };
}
