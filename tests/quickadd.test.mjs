import './setup.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><div id="mount"></div></body>', { url: 'http://localhost/#/expenses?add=1', pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.history = dom.window.history;
globalThis.location = dom.window.location;

const { resetDb, bank } = await import('./helpers.mjs');
const { renderExpensesPage } = await import('../js/pages/expenses-page.js');
const { renderIncomePage } = await import('../js/pages/income-page.js');
const { renderTransfersPage } = await import('../js/pages/transfers-page.js');
const { closeModal } = await import('../js/core/modal.js');
const { consumeAddParam } = await import('../js/utils/dom.js');

beforeEach(async () => { closeModal(); document.querySelector('#mount').innerHTML = ''; await resetDb(); await bank('A', 1000); await bank('B', 1000); });

const mount = () => document.querySelector('#mount');
const title = () => document.querySelector('.modal-header h2')?.textContent;

test('quick-add: ?add=1 opens the Add Expense modal and cleans the URL', async () => {
  await renderExpensesPage(mount(), new URLSearchParams('add=1'));
  assert.ok(title(), 'a modal should be open');
  assert.match(title(), /expense/i);
  assert.equal(location.hash, '#/expenses');         // flag stripped -> refresh won't re-open it
});

test('quick-add: ?add=1 opens Add Income and Add Transfer', async () => {
  await renderIncomePage(mount(), new URLSearchParams('add=1'));
  assert.match(title(), /income/i);
  closeModal();
  await renderTransfersPage(mount(), new URLSearchParams('add=1'));
  assert.match(title(), /transfer/i);
});

test('quick-add: normal visits do NOT open a modal', async () => {
  await renderExpensesPage(mount(), new URLSearchParams(''));
  await renderIncomePage(mount());                      // params undefined (old call style) still works
  assert.equal(document.querySelector('.modal'), null);
  assert.equal(consumeAddParam(new URLSearchParams('add=0'), 'expenses'), false);
});

test('quick-add: the page Add button still works (transfer button no longer leaks the click event)', async () => {
  await renderTransfersPage(mount(), new URLSearchParams(''));
  document.querySelector('#btn-add-transfer').click();
  await new Promise((r) => setTimeout(r, 30));
  assert.match(title(), /transfer/i);
});
