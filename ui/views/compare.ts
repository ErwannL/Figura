import type { Ctx } from '../context.js';
import { h } from '../dom.js';
import type { PublicRun } from '../types.js';

export async function compareView(ctx: Ctx): Promise<HTMLElement> {
  const { doc, t } = ctx;
  const { runs } = await ctx.api.get<{ runs: PublicRun[] }>('/api/runs');
  const done = runs.filter((r) => r.status === 'done' && r.kind === 'journey');
  const pick = (name: string, label: string) =>
    h(
      doc,
      'label',
      {},
      label,
      h(
        doc,
        'select',
        { name, disabled: done.length === 0 },
        ...done.map((r) =>
          h(doc, 'option', { value: r.id }, `${r.id} ${r.label} (seed ${r.seed})`),
        ),
      ),
    );
  const out = h(doc, 'p', {});
  const empty = h(doc, 'p', { role: 'status', hidden: done.length > 0 }, t('compare.none'));
  const form = h(
    doc,
    'form',
    {},
    pick('a', t('compare.a')),
    pick('b', t('compare.b')),
    h(doc, 'button', { type: 'submit', disabled: done.length === 0 }, t('compare.submit')),
    empty,
    out,
  ) as HTMLFormElement;
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const a = (form.elements.namedItem('a') as HTMLSelectElement).value;
    const b = (form.elements.namedItem('b') as HTMLSelectElement).value;
    const q = `a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}&lang=${ctx.locale}`;
    out.replaceChildren(
      h(doc, 'a', { href: `/api/compare?${q}&format=html` }, t('run.downloadHtml')),
      ' · ',
      h(doc, 'a', { href: `/api/compare?${q}` }, t('run.downloadJson')),
    );
  });
  return h(doc, 'section', {}, h(doc, 'h1', {}, t('compare.title')), form);
}
