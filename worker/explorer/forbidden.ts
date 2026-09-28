/**
 * What an explorer never activates (docs/EXPLORATEUR.md, guard 4). Matched on structure first —
 * role, href / route, the form's action, the origin — and on the English accessible name only as a
 * second signal (explorer personas are fixed to `en`; Orqea speaks 23 languages).
 */

/** What the page scan reports of one interactive element (see page-scan.ts). */
export interface Control {
  /** Index stamped on the element (`data-figura-x`), to act on it. */
  idx: number;
  role: string;
  name: string;
  tag: string;
  /** `type` attribute of inputs and buttons, lower-cased ('' when none). */
  type: string;
  /** Absolute URL of a link. */
  href: string | null;
  /** `METHOD target` of the enclosing form (`action` or `data-api`), '' when none. */
  form: string;
  /** Id of the enclosing form (its index among forms), -1 when none. */
  formId: number;
  formHasPassword: boolean;
  /** Current values of the email fields of the enclosing form. */
  formEmails: string[];
  /** `aria-expanded` of the control, null when absent. */
  expanded: boolean | null;
  inModal: boolean;
  draggable: boolean;
  /** `data-danger` of the control or its nearest ancestor (Orqea marks its dangerous controls), null when none. */
  danger: string | null;
  box: { x: number; y: number; width: number; height: number };
}

export interface ForbiddenRule {
  key: string;
  why: string;
  test: (c: Control, origin: string) => boolean;
}

const OAUTH = /\b(github|google|discord|trello|jira|gitlab|atlassian)\b/i;
const OAUTH_HOSTS =
  /(^|\.)(github\.com|google\.com|googleapis\.com|discord\.com|trello\.com|atlassian\.(com|net)|gitlab\.com)$/i;
const where = (c: Control): string => `${c.href ?? ''} ${c.form}`.toLowerCase();
const submitsForm = (c: Control): boolean => c.formId >= 0 && c.role === 'button';
const offOrigin = (url: string, origin: string): boolean => {
  try {
    return new URL(url).origin !== origin;
  } catch {
    return false;
  }
};
const SYNTHETIC = /@synthetic\.invalid$/i;

export const FORBIDDEN: ForbiddenRule[] = [
  {
    key: 'danger-marked',
    why: 'Orqea marks it data-danger (logout, account deletion, export, credentials, encryption, payment, OAuth, SSH): language-proof',
    test: (c) => c.danger !== null,
  },
  {
    key: 'logout',
    why: 'ends the session (only a scripted logout + login is allowed)',
    test: (c) =>
      /\/(auth\/)?(logout|signout|sign-out|log-out)\b/.test(where(c)) ||
      /^(log|sign) ?out\b/i.test(c.name),
  },
  {
    key: 'account-delete',
    why: 'deletes the synthetic account before cleanup can account for it',
    test: (c) =>
      /delete \/api\/(user|users|account)\/me\b|\/account\/delete|\/delete-account/.test(
        where(c),
      ) || /delete (my |your |the )?account|confirm deletion/i.test(c.name),
  },
  {
    key: 'data-export',
    why: 'GDPR export: heavy and pointless for a synthetic account',
    test: (c) => /\/export\b/.test(where(c)) || /export (my |your |all )?data/i.test(c.name),
  },
  {
    key: 'credentials',
    why: 'password or e-mail change, deletion confirmation: anything in a form with a password field',
    test: (c) =>
      c.formHasPassword ||
      /\/(password|email)\b/.test(c.form.toLowerCase()) ||
      /change (my |your )?(password|e-?mail)/i.test(c.name),
  },
  {
    key: 'board-encryption',
    why: 'encrypts a board with a passphrase',
    test: (c) => /encrypt|passphrase/.test(where(c)) || /encrypt|passphrase/i.test(c.name),
  },
  {
    key: 'payment',
    why: 'Stripe Checkout, customer portal, plan purchase',
    test: (c) =>
      /\/billing\/(checkout|portal|subscribe)|stripe\.com|\/checkout\b/.test(where(c)) ||
      /checkout|billing portal|manage (subscription|billing)|subscribe|upgrade|^choose\b|\bpay\b/i.test(
        c.name,
      ),
  },
  {
    key: 'oauth',
    why: 'connects a third-party account (GitHub, Google, Discord, Trello, Jira, GitLab)',
    test: (c) =>
      /\/(oauth|auth)\/(github|google|discord|trello|jira|gitlab|atlassian)\b|\/oauth\b|\/integrations\/[a-z]+\/connect/.test(
        where(c),
      ) ||
      (c.href !== null && safeHost(c.href, OAUTH_HOSTS)) ||
      (/(connect|sign in|log in|continue|import|link)\b/i.test(c.name) && OAUTH.test(c.name)),
  },
  {
    key: 'ssh',
    why: 'remote SSH servers',
    test: (c) => /\/ssh\b|ssh-/.test(where(c)) || /\bssh\b|remote server/i.test(c.name),
  },
  {
    key: 'invite-non-synthetic',
    why: 'an invitation may only go to an @synthetic.invalid address',
    test: (c) =>
      submitsForm(c) && c.formEmails.some((e) => e.trim() !== '' && !SYNTHETIC.test(e.trim())),
  },
  {
    key: 'external-link',
    why: 'leaves the target origin',
    test: (c, origin) => c.href !== null && /^https?:/i.test(c.href) && offOrigin(c.href, origin),
  },
];

function safeHost(url: string, re: RegExp): boolean {
  try {
    return re.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** The first forbidden rule matching the control, null when it may be activated. */
export function forbiddenRule(c: Control, origin: string): ForbiddenRule | null {
  return FORBIDDEN.find((r) => r.test(c, origin)) ?? null;
}
