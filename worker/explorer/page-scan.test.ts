import { afterEach, describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { HELPERS, isRawKey, scanPage, scanScript } from './page-scan.js';

type Box = { x?: number; y?: number; width?: number; height?: number };

/** happy-dom has no layout: boxes come from `data-box="x,y,w,h"` (default 10,10,100,32). */
function scan(html: string, o: { width?: number; docWidth?: number; url?: string } = {}) {
  const win = new Window({
    width: o.width ?? 1024,
    height: 700,
    url: o.url ?? 'http://app.test/board/7',
  });
  const doc = win.document as unknown as Document;
  doc.body.innerHTML = html;
  const proto = (win as unknown as { Element: { prototype: Element } }).Element.prototype;
  proto.getBoundingClientRect = function (this: Element) {
    const [x, y, width, height] = (this.getAttribute('data-box') ?? '10,10,100,32')
      .split(',')
      .map(Number) as number[];
    return { x, y, width, height } as Box as DOMRect;
  };
  if (o.docWidth !== undefined)
    Object.defineProperty(doc.documentElement, 'scrollWidth', { value: o.docWidth });
  return { result: scanPage(doc, win as unknown as globalThis.Window, HELPERS), doc };
}

afterEach(() => undefined);

describe('scanPage: inventory', () => {
  it('lists visible, enabled, on-screen controls once, stamps them, reads forms', () => {
    const { result, doc } = scan(`
      <a href="/dashboard">Home</a><a href="/dashboard">Home</a>
      <button disabled>Off</button><button aria-disabled="true">Off2</button>
      <button hidden>Hidden</button><input type="hidden" name="h">
      <button data-box="0,0,0,0">Zero</button><button data-box="-500,0,100,30">Left</button>
      <button aria-expanded="false" aria-label="Menu"></button>
      <form data-api="POST /api/boards"><label>Name <input name="n"></label><input type="email" value="a@b.c"><input type="password"><button>Create</button></form>
      <form method="post" action="/x"><textarea aria-label="Note"></textarea><input type="number" aria-label="N"></form>
      <div role="dialog"><div role="tab" tabindex="0">Tab</div></div>
      <div draggable="true" role="button">Card</div><form><button>Bare</button></form>`);
    const names = result.controls.map((c) => `${c.role}:${c.name}`);
    expect(names).toEqual([
      'link:Home',
      'button:Menu',
      'textbox:Name',
      'textbox:',
      'textbox:',
      'button:Create',
      'textbox:Note',
      'textbox:N',
      'tab:Tab',
      'button:Card',
      'button:Bare',
    ]);
    expect(result.controls[10]).toMatchObject({ form: '', formId: 2 });
    expect(result.controls[0]).toMatchObject({
      href: 'http://app.test/dashboard',
      form: '',
      formId: -1,
    });
    expect(result.controls[1]).toMatchObject({ expanded: false });
    expect(result.controls[5]).toMatchObject({
      form: 'POST /api/boards',
      formId: 0,
      formHasPassword: true,
      formEmails: ['a@b.c'],
    });
    expect(result.controls[6]).toMatchObject({
      form: 'POST /x',
      formId: 1,
      formHasPassword: false,
    });
    expect(result.controls[8]).toMatchObject({ inModal: true });
    expect(result.controls[9]).toMatchObject({ draggable: true, expanded: null });
    expect(doc.querySelectorAll('[data-figura-x]').length).toBe(11);
    expect(result.modal).toBe(true);
    expect(result.offscreen).toEqual(['button "Left"']);
  });
});

describe('scanPage: detectors (each with a healthy page)', () => {
  it('horizontal scroll: document wider than the viewport', () => {
    expect(scan('<p>x</p>', { width: 400, docWidth: 900 }).result.docWidth).toBe(900);
    expect(scan('<p>x</p>', { width: 400, docWidth: 400 }).result.docWidth).toBe(400);
  });

  it('small touch targets', () => {
    expect(scan('<button data-box="0,0,20,20">x</button>').result.smallTargets).toEqual([
      'button "x" 20×20',
    ]);
    expect(scan('<button data-box="0,0,44,44">x</button>').result.smallTargets).toEqual([]);
  });

  it('unnamed buttons and links; images without alt', () => {
    const bad = scan('<button></button><a href="/x"><img src="/i.png?v=1"></a><img>').result;
    expect(bad.unnamed).toHaveLength(2);
    expect(bad.imgNoAlt).toEqual(['/i.png', '']);
    const ok = scan(
      '<button>OK</button><img src="/d.png" alt=""><img src="/p.png" role="presentation">',
    ).result;
    expect([ok.unnamed, ok.imgNoAlt]).toEqual([[], []]);
  });

  it('raw i18n keys', () => {
    expect(
      scan('<p>auth.oauth_error.something</p><p>auth.oauth_error.something</p>').result.rawKeys,
    ).toEqual(['auth.oauth_error.something']);
    expect(scan('<p>Visit orqea.app or read notes.md</p><p>v1.2</p>').result.rawKeys).toEqual([]);
    expect([
      isRawKey('common.save_button'),
      isRawKey('a.b'),
      isRawKey('orqea.example.com'),
      isRawKey('Hello world'),
    ]).toEqual([true, false, false, false]);
  });

  it('user HTML interpreted instead of shown', () => {
    expect(scan('<div><b>fxh1234</b></div>').result.htmlInjected).toEqual(['fxh1234']);
    expect(scan('<div>&lt;b&gt;fxh1234&lt;/b&gt;</div>').result.htmlInjected).toEqual([]);
  });

  it('text overflowing its container (not when overflow is planned)', () => {
    const { result } = scanWithWidths(
      '<p id="a">long text</p><p id="b" style="overflow:hidden">clipped</p><p id="c">fits</p>',
    );
    expect(result.textOverflow).toEqual(['p: long text']);
  });

  it('NotFound pages; scripts and hidden text ignored', () => {
    expect(scan('<h1>Page not found</h1>').result.notFound).toBe(true);
    expect(
      scan('<h1>Dashboard</h1><script>auth.key_x.y</script><p hidden>a.b_c.d</p>').result,
    ).toMatchObject({ notFound: false, rawKeys: [] });
  });
});

function scanWithWidths(html: string) {
  const win = new Window({ width: 1024, height: 700, url: 'http://app.test/' });
  const doc = win.document as unknown as Document;
  doc.body.innerHTML = html;
  const size = (id: string, scroll: number, client: number) => {
    const el = doc.getElementById(id) as HTMLElement;
    Object.defineProperty(el, 'scrollWidth', { value: scroll });
    Object.defineProperty(el, 'clientWidth', { value: client });
  };
  size('a', 300, 100);
  size('b', 300, 100);
  size('c', 100, 100);
  return { result: scanPage(doc, win as unknown as globalThis.Window, HELPERS) };
}

describe('scanScript', () => {
  it('is self-contained source that runs in a page', () => {
    const script = scanScript();
    expect(script).toContain('function roleOfControl(');
    expect(script).toMatch(
      /\)\(document, window, \{ isHidden, textOf, accessibleName, roleOf \}\);\n\}\)\(\)$/,
    );
    const win = new Window({ url: 'http://app.test/' });
    win.document.body.innerHTML = '<h1>404</h1>';
    const run = new win.Function('document', 'window', `return ${script}`) as (
      d: unknown,
      w: unknown,
    ) => { notFound: boolean };
    expect(run(win.document, win).notFound).toBe(true);
  });
});
