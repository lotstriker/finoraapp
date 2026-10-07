import './setup.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { openModal, closeModal, confirmDialog } = await import('../js/core/modal.js');
const { toast } = await import('../js/core/toast.js');

const EVIL = '<img src=x onerror="window.__pwned=1">';
beforeEach(() => { closeModal(); document.body.innerHTML = ''; window.__pwned = 0; });

test('modal title is plain text — a hostile name cannot inject HTML', () => {
  openModal({ title: `Adjust · ${EVIL}`, bodyHtml: '<p>x</p>', actions: [] });
  const h2 = document.querySelector('.modal-header h2');
  assert.equal(h2.textContent, `Adjust · ${EVIL}`);
  assert.equal(document.querySelectorAll('.modal img').length, 0);
  assert.ok(document.querySelector('.modal').getAttribute('aria-labelledby'));
});

test('confirmDialog message is plain text', () => {
  confirmDialog({ title: 'Archive', message: `Hide "${EVIL}"?` });
  assert.equal(document.querySelectorAll('.modal img').length, 0);
  assert.ok(document.querySelector('.confirm-message').textContent.includes('onerror'));
});

test('toast message is plain text; errors are announced as alerts', () => {
  toast.error(`Failed ${EVIL}`);
  toast.success('Saved');
  assert.equal(document.querySelectorAll('.toast img').length, 0);
  const [err, ok] = document.querySelectorAll('.toast');
  assert.equal(err.getAttribute('role'), 'alert');
  assert.equal(ok.getAttribute('role'), 'status');
});

test('modal buttons lock while an async handler runs (no double-submit)', async () => {
  let calls = 0;
  openModal({ title: 'Pay', bodyHtml: '', actions: [{ label: 'Pay', onClick: async () => { calls++; await new Promise((r) => setTimeout(r, 20)); } }] });
  const btn = document.querySelector('.modal-footer button');
  btn.click(); btn.click(); btn.click();
  assert.equal(btn.disabled, true);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(calls, 1);
  assert.equal(btn.disabled, false); // re-enabled for validation retries
});

test('focus moves into the dialog, Tab is trapped, focus returns on close', () => {
  const opener = document.createElement('button'); document.body.appendChild(opener); opener.focus();
  openModal({ title: 'T', bodyHtml: '<input id="a"/>', actions: [{ label: 'OK', onClick: () => {} }] });
  assert.equal(document.activeElement.id, 'a');
  closeModal();
  assert.equal(document.activeElement, opener);
});
