import type { Control } from '../forbidden.js';

/** A page-scan control with sensible defaults. */
export function control(o: Partial<Control> = {}): Control {
  return {
    idx: 0,
    role: 'button',
    name: 'Save',
    tag: 'button',
    type: '',
    href: null,
    form: '',
    formId: -1,
    formHasPassword: false,
    formEmails: [],
    expanded: null,
    inModal: false,
    draggable: false,
    box: { x: 0, y: 0, width: 80, height: 32 },
    ...o,
  };
}
