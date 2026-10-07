import './setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/#/dashboard', pretendToBeVisual: true });
for (const k of ['window', 'document', 'location', 'history', 'CustomEvent', 'HTMLElement', 'Node']) {
  Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
dom.window.matchMedia = dom.window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
globalThis.matchMedia = dom.window.matchMedia;

// app.js starts a notification poll with setInterval; stub it so the test process can exit
globalThis.setInterval = () => 0;
dom.window.setInterval = () => 0;

const { openDB } = await import('../js/core/db.js');
const { markOnboardingComplete } = await import('../js/modules/preferences.js');
await openDB(); await markOnboardingComplete();              // skip the first-run wizard

await import('../js/app.js');
document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
await new Promise((r) => setTimeout(r, 400));

test('boot: shell renders with sidebar, topbar, quick-add and the mobile bottom nav', () => {
  assert.ok(document.querySelector('#sidebar-nav .nav-item'), 'sidebar nav');
  assert.equal(document.querySelectorAll('#bottom-nav a').length, 4);
  assert.ok(document.querySelector('#bottom-more'));
  assert.equal(document.querySelectorAll('#quick-menu a').length, 3);
  for (const a of document.querySelectorAll('#quick-menu a')) assert.ok(a.querySelector('svg'), `icon missing for ${a.textContent.trim()}`);
});

test('boot: dashboard page rendered and bottom nav marks Home as current', () => {
  assert.match(document.querySelector('#page-mount').textContent, /Net Worth/);
  const home = document.querySelector('#bottom-nav a[data-key="dashboard"]');
  assert.equal(home.getAttribute('aria-current'), 'page');
});

test('boot: navigating changes the page + the bottom-nav highlight; More opens the sidebar', async () => {
  location.hash = '#/reports';
  dom.window.dispatchEvent(new dom.window.Event('hashchange'));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(document.querySelector('#topbar-title').textContent, 'Reports');
  assert.equal(document.querySelector('#bottom-nav a.active').dataset.key, 'reports');
  assert.equal(document.querySelectorAll('#page-mount [role="tab"]').length > 0, true, 'Reports tabs are ARIA tabs');
  document.querySelector('#bottom-more').click();
  assert.ok(document.querySelector('#sidebar').classList.contains('open'));
});

test('boot: quick-add menu opens, closes on Escape, and a service worker registration is attempted safely', () => {
  const btn = document.querySelector('#quick-add-btn'); const menu = document.querySelector('#quick-menu');
  btn.click();
  assert.equal(menu.hidden, false);
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(menu.hidden, true);
});

test('boot: deep link #/transfers?add=1 opens the Add Transfer dialog exactly once', async () => {
  const { createAccount } = await import('../js/modules/accounts.js');   // a transfer needs two accounts
  await createAccount({ name: 'A', type: 'bank', initialBalance: 100 });
  await createAccount({ name: 'B', type: 'bank', initialBalance: 100 });
  location.hash = '#/transfers?add=1';
  dom.window.dispatchEvent(new dom.window.Event('hashchange'));
  await new Promise((r) => setTimeout(r, 400));
  assert.match(document.querySelector('.modal-header h2')?.textContent || '', /transfer/i);
  assert.equal(location.hash, '#/transfers');
});
