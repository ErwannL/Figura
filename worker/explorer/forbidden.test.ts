import { describe, expect, it } from 'vitest';
import { FORBIDDEN, forbiddenRule, type Control } from './forbidden.js';
import { control } from './test-helpers/controls.js';

const ORIGIN = 'http://localhost:3001';
const link = (href: string, name = 'Go') =>
  control({ role: 'link', tag: 'a', name, href: new URL(href, ORIGIN).href });

/** Every catalogue entry with at least one structural case (no text) and, when it has one, a name case. */
const CASES: Record<string, Control[]> = {
  'danger-marked': [
    control({ name: 'Déconnexion', danger: 'logout' }),
    control({ role: 'link', tag: 'a', name: '支払う', danger: 'payment' }),
  ],
  logout: [
    link('/logout', '⎋'),
    control({ form: 'POST /api/auth/logout', formId: 0 }),
    control({ name: 'Log out' }),
  ],
  'account-delete': [
    control({ form: 'DELETE /api/user/me', formId: 0, name: '✕' }),
    link('/account/delete', '…'),
    control({ name: 'Delete my account' }),
  ],
  'data-export': [
    control({ form: 'GET /api/user/me/export', formId: 1, name: '⤓' }),
    control({ name: 'Export my data' }),
  ],
  credentials: [
    control({ formId: 0, formHasPassword: true, name: 'Save' }),
    control({ role: 'textbox', tag: 'input', formId: 0, formHasPassword: true, name: '' }),
    control({ form: 'PUT /api/user/me/email', formId: 0, name: 'OK' }),
    control({ name: 'Change password' }),
  ],
  'board-encryption': [
    control({ form: 'POST /api/boards/:id/encrypt', formId: 0, name: 'OK' }),
    control({ name: 'Encrypt this board' }),
  ],
  payment: [
    control({ form: 'POST /api/billing/checkout', formId: 2, name: '→' }),
    link('https://checkout.stripe.com/pay/x', '→'),
    link('/billing/portal', '→'),
    control({ name: 'Choose Pro' }),
    control({ name: 'Upgrade' }),
  ],
  oauth: [
    link('/api/auth/github', '→'),
    link('/integrations/jira/connect', '→'),
    control({ name: 'Continue with Google' }),
    control({ name: 'Connect Discord' }),
  ],
  ssh: [link('/settings/ssh', '→'), control({ name: 'Add remote server' })],
  'invite-non-synthetic': [
    control({ formId: 3, formEmails: ['someone@gmail.com'], name: 'Invite' }),
  ],
  'external-link': [
    link('https://example.com/help', 'Help'),
    link('http://localhost:9999/', 'Other port'),
  ],
};

describe('forbidden-action catalogue', () => {
  it('has a test case for every entry, and each case is caught by that entry', () => {
    expect(Object.keys(CASES).sort()).toEqual(FORBIDDEN.map((r) => r.key).sort());
    for (const [key, cases] of Object.entries(CASES)) {
      const rule = FORBIDDEN.find((r) => r.key === key)!;
      for (const c of cases)
        expect(rule.test(c, ORIGIN), `${key}: ${JSON.stringify(c)}`).toBe(true);
    }
  });

  it('lets ordinary controls through', () => {
    const ok = [
      control(),
      control({ name: 'Create board', formId: 0, form: 'POST /api/boards' }),
      link('/dashboard', 'Home'),
      link('/settings?tab=appearance', 'Settings'),
      control({ formId: 3, formEmails: ['synth+r1-x@synthetic.invalid', ''], name: 'Invite' }),
      control({ role: 'link', href: 'mailto:help@orqea.example', name: 'Mail us' }),
      control({ role: 'link', href: 'not a url', name: 'Odd' }),
      control({ name: 'GitHub stars' }),
    ];
    for (const c of ok) expect(forbiddenRule(c, ORIGIN), JSON.stringify(c)).toBeNull();
    expect(forbiddenRule(control({ name: 'Log out' }), ORIGIN)?.key).toBe('logout');
  });

  it('never throws on a malformed href', () => {
    const odd = control({ role: 'link', href: 'http://[bad', name: 'x' });
    expect(forbiddenRule(odd, ORIGIN)).toBeNull();
  });
});
