import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';

let style: HTMLStyleElement | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  style?.remove();
  host?.remove();
});

it('keeps Bootstrap scoped without hiding flex input values or flattening Studio buttons', () => {
  style = document.createElement('style');
  style.textContent = [
    '../src/styles.css',
    '../src/studio/bootstrap-scoped.css',
    '../src/studio/desk.css',
  ]
    .map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'))
    .join('\n');
  document.head.appendChild(style);
  host = document.createElement('div');
  host.innerHTML =
    '<div class="studio-root" data-bs-theme="dark"><label class="desk-inline-field"><span>Seed</span><input value="1234567890"></label><button class="desk-icon-button">Reuse</button></div><label class="outside">Outside Studio</label>';
  document.body.appendChild(host);
  expect(getComputedStyle(host.querySelector('.desk-inline-field')!).display).toBe('flex');
  expect(getComputedStyle(host.querySelector('input')!).flexGrow).toBe('1');
  expect(getComputedStyle(host.querySelector('input')!).minHeight).toBe('0');
  expect(getComputedStyle(host.querySelector('button')!).borderRadius).toBe('6px');
  expect(getComputedStyle(host.querySelector('.outside')!).display).not.toBe('inline-block');
});
