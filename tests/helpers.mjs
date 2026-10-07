import './setup.mjs';
import { openDB, getAll, getById, withTransaction } from '../js/core/db.js';
import { deleteAllData } from '../js/modules/backup.js';
import { seedDefaultCategories } from '../js/modules/categories.js';
import { createAccount } from '../js/modules/accounts.js';

export { getAll, getById, withTransaction };

/** Fresh, empty database (with default categories) for every test. */
export async function resetDb() {
  await openDB();
  await deleteAllData();
  await seedDefaultCategories();
}

export const bank = (name = 'Bank', initialBalance = 10000) =>
  createAccount({ name, type: 'bank', initialBalance });

export const balanceOf = async (id) => (await getById('accounts', id)).balance;
export const totalMoney = async () => (await getAll('accounts')).reduce((s, a) => s + a.balance, 0);
