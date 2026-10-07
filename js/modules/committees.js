// ==========================================================================
// Finora — modules/committees.js
// Formulas locked in 12/13/14 - Bid & Save:
//   discountPerMembership = winningBid / numberOfMembers
//   payablePerMembership  = baseContribution - discountPerMembership
//   totalPayable          = payablePerMembership * userMemberships
//   userSaving (= "your profit") = discountPerMembership * userMemberships
//   payout (only if userWon) = totalAmount - winningBid   (NOT multiplied by
//     memberships — only one slot wins per cycle, at most one of the
//     user's slots can win in a given month)
//   Skip (winningBid = 0): discount/saving/payout all 0, full base
//     contribution remains payable.
//
// Fixes applied across two rounds of review, all verified against actual
// code (not assumed):
//   - Bid can no longer be >= the total committee amount.
//   - Individual membership slot records now exist in committee_memberships
//     (previously only a userMemberships COUNT was stored) — created
//     atomically with the committee + cycles.
//   - A win can optionally record WHICH slot won (winnerMembershipId).
//   - Contribution + payout post inside ONE atomic transaction.
//   - reverseCycle() is now FULLY atomic — reversing the payout, reversing
//     the contribution, and resetting the cycle/committee state all happen
//     in ONE IndexedDB transaction (previously the payout reversal was a
//     separate outer transaction, so a failure between the two could leave
//     things half-reversed).
//   - Cycle/committee-end-date generation uses addMonthsClamped.
//   - All computed money values pass through roundMoney.
// ==========================================================================

import { withTransaction, reqToPromise, getAll, getById } from '../core/db.js';
import { createTransaction, postLinkedTransaction, postLinkedReversal, ValidationError } from '../core/ledger.js';
import { newId } from '../core/ids.js';
import { addMonthsClamped } from '../utils/date.js';
import { roundMoney } from '../utils/currency.js';

export async function getCommittees() {
  const all = await getAll('committees');
  return all.sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'completed' ? 1 : -1));
}

export async function getCommitteeById(id) {
  return getById('committees', id);
}

export async function getCycles(committeeId) {
  return withTransaction(['committee_cycles'], 'readonly', async (tx) => {
    const all = await reqToPromise(tx.objectStore('committee_cycles').index('committeeId').getAll(committeeId));
    return all.sort((a, b) => a.cycleNo - b.cycleNo);
  });
}

/** The user's own individual membership slots in a committee. */
export async function getMemberships(committeeId) {
  return withTransaction(['committee_memberships'], 'readonly', async (tx) => {
    const all = await reqToPromise(tx.objectStore('committee_memberships').index('committeeId').getAll(committeeId));
    return all.sort((a, b) => a.slotNumber - b.slotNumber);
  });
}

export function committeeProgress(cycles) {
  const recorded = cycles.filter((c) => c.status === 'recorded');
  return {
    recordedCount: recorded.length,
    totalCycles: cycles.length,
    totalPaid: recorded.reduce((s, c) => s + (c.totalPayable || 0), 0),
    totalSaving: recorded.reduce((s, c) => s + (c.userSaving || 0), 0),
    totalReceived: recorded.filter((c) => c.userWon).reduce((s, c) => s + (c.payout || 0), 0),
  };
}

/**
 * @param {object} input
 * @param {string} input.name
 * @param {number} input.totalAmount
 * @param {number} input.numberOfMembers
 * @param {number} input.userMemberships
 * @param {string} input.startDate ISO date
 */
export async function createCommittee(input) {
  if (!input.name?.trim()) throw new ValidationError('Committee name is required.');
  if (!(Number(input.totalAmount) > 0)) throw new ValidationError('Total amount must be greater than ₹0.');
  if (!(Number(input.numberOfMembers) > 0)) throw new ValidationError('Number of members must be at least 1.');
  if (!(Number(input.userMemberships) > 0)) throw new ValidationError('You need at least 1 membership.');
  if (Number(input.userMemberships) > Number(input.numberOfMembers)) {
    throw new ValidationError('Your memberships cannot exceed the number of members.');
  }

  // Optional foreman commission (registered chit funds): taken out of the winning bid
  // ("discount") before the rest is shared as dividend. 0 = informal committee (default).
  const commissionPercent = Number(input.commissionPercent) || 0;
  if (commissionPercent < 0 || commissionPercent > 20) {
    throw new ValidationError('Foreman commission must be between 0% and 20%.');
  }

  const numberOfMembers = Number(input.numberOfMembers);
  const userMemberships = Number(input.userMemberships);
  const totalAmount = Number(input.totalAmount);
  const baseContribution = roundMoney(totalAmount / numberOfMembers);
  const startDate = input.startDate || new Date().toISOString();

  const committee = {
    id: newId('cmt'),
    name: input.name.trim(),
    totalAmount,
    numberOfMembers,
    userMemberships,
    baseContribution,
    commissionPercent,
    duration: numberOfMembers,
    startDate,
    endDate: addMonthsClamped(startDate, numberOfMembers).toISOString(),
    status: 'active',
    createdAt: new Date().toISOString(),
  };

  const cycles = Array.from({ length: numberOfMembers }, (_, i) => ({
    id: newId('cyc'),
    committeeId: committee.id,
    cycleNo: i + 1,
    month: addMonthsClamped(startDate, i).toISOString(),
    status: 'pending',
    winningBid: 0,
    discountPerMembership: 0,
    payablePerMembership: 0,
    totalPayable: 0,
    payout: 0,
    userWon: false,
    winnerName: '',
    winnerMembershipId: null,
    userSaving: 0,
    transactionId: null,
    payoutTransactionId: null,
  }));

  // Individual membership slots — previously only the count was stored.
  const memberships = Array.from({ length: userMemberships }, (_, i) => ({
    id: newId('mem'),
    committeeId: committee.id,
    slotNumber: i + 1,
    status: 'active',
    createdAt: new Date().toISOString(),
  }));

  await withTransaction(['committees', 'committee_cycles', 'committee_memberships'], 'readwrite', (tx) => {
    tx.objectStore('committees').put(committee);
    const cycleStore = tx.objectStore('committee_cycles');
    cycles.forEach((c) => cycleStore.put(c));
    const membershipStore = tx.objectStore('committee_memberships');
    memberships.forEach((m) => membershipStore.put(m));
  });

  return committee;
}

/**
 * Records a cycle's bid outcome, posts the always-due contribution to the
 * ledger, and — only for the user's own win — the payout, all inside ONE
 * atomic transaction. A skip (winningBid = 0) always forces userWon = false.
 *
 * @param {string} committeeId
 * @param {string} cycleId
 * @param {object} input
 * @param {number} input.winningBid 0 for a skip/no-bid month
 * @param {boolean} input.userWon
 * @param {string} [input.winnerMembershipId] which of the user's own slots won, if userWon and they have more than one
 * @param {string} [input.winnerName]
 * @param {string} input.paymentAccountId account the contribution is paid from
 * @param {string} [input.payoutAccountId] required only if userWon and payout > 0; omit entirely for "Do not add to an account"
 */
export async function recordCycle(committeeId, cycleId, input) {
  const committee = await getById('committees', committeeId);
  if (!committee) throw new ValidationError('Committee not found.');
  const cycle = await getById('committee_cycles', cycleId);
  if (!cycle) throw new ValidationError('Cycle not found.');
  if (cycle.status === 'recorded') throw new ValidationError('This cycle has already been recorded.');
  if (!input.paymentAccountId) throw new ValidationError('Select an account to pay the contribution from.');

  const winningBid = Number(input.winningBid) || 0;
  if (winningBid < 0) throw new ValidationError('Winning bid cannot be negative.');
  if (winningBid >= committee.totalAmount) {
    throw new ValidationError('Winning bid cannot be equal to or greater than the committee amount.');
  }
  const isSkip = winningBid === 0;
  const userWon = isSkip ? false : !!input.userWon;

  if (userWon) {
    const allCycles = await getCycles(committeeId);
    const priorWins = allCycles.filter((c) => c.id !== cycleId && c.status === 'recorded' && c.userWon);
    if (priorWins.length >= committee.userMemberships) {
      throw new ValidationError(
        `You only have ${committee.userMemberships} membership${committee.userMemberships > 1 ? 's' : ''} in this committee, and ${priorWins.length > 1 ? 'they have' : 'it has'} already won ${priorWins.length} time${priorWins.length > 1 ? 's' : ''}. Each membership can only win once.`
      );
    }
    if (input.winnerMembershipId && priorWins.some((c) => c.winnerMembershipId === input.winnerMembershipId)) {
      throw new ValidationError('This membership has already won a cycle — pick the other one.');
    }
  }

  // Foreman commission comes out of the bid; only the remainder is shared back (dividend).
  const commission = isSkip ? 0 : roundMoney(committee.totalAmount * (Number(committee.commissionPercent) || 0) / 100);
  if (!isSkip && winningBid < commission) {
    throw new ValidationError(`The winning bid must be at least the foreman's commission (${commission}).`);
  }
  const discountPerMembership = roundMoney((winningBid - commission) / committee.numberOfMembers);
  const payablePerMembership = roundMoney(committee.baseContribution - discountPerMembership);
  const totalPayable = roundMoney(payablePerMembership * committee.userMemberships);
  const userSaving = roundMoney(discountPerMembership * committee.userMemberships);
  const payout = userWon ? roundMoney(committee.totalAmount - winningBid) : 0;

  const paymentRecord = await createTransaction({
    type: 'committee_payment',
    direction: 'out',
    accountId: input.paymentAccountId,
    amount: totalPayable,
    module: 'bidsave',
    moduleRef: cycleId,
    description: `${committee.name} — Cycle #${cycle.cycleNo} contribution`,
  }, {
    extraStores: ['committee_cycles', 'committees'],
    sideEffect: async (tx, record) => {
      const fresh = await reqToPromise(tx.objectStore('committee_cycles').get(cycleId));
      if (!fresh || fresh.status === 'recorded') throw new ValidationError('This cycle has already been recorded.');
      let payoutTransactionId = null;
      if (userWon && payout > 0 && input.payoutAccountId) {
        const payoutRecord = await postLinkedTransaction(tx, {
          type: 'committee_payout',
          direction: 'in',
          accountId: input.payoutAccountId,
          amount: payout,
          module: 'bidsave',
          moduleRef: cycleId,
          description: `${committee.name} — Cycle #${cycle.cycleNo} payout`,
        });
        payoutTransactionId = payoutRecord.id;
      }

      const cycleStore = tx.objectStore('committee_cycles');
      const c = await reqToPromise(cycleStore.get(cycleId));
      Object.assign(c, {
        status: 'recorded',
        winningBid,
        discountPerMembership,
        payablePerMembership,
        totalPayable,
        payout,
        userWon,
        winnerName: isSkip ? '' : (input.winnerName || ''),
        winnerMembershipId: userWon ? (input.winnerMembershipId || null) : null,
        userSaving,
        transactionId: record.id,
        payoutTransactionId,
      });
      cycleStore.put(c);

      const allCycles = await reqToPromise(cycleStore.index('committeeId').getAll(committeeId));
      const allDone = allCycles.every((x) => (x.id === cycleId ? true : x.status === 'recorded'));
      if (allDone) {
        const committeesStore = tx.objectStore('committees');
        const cRec = await reqToPromise(committeesStore.get(committeeId));
        cRec.status = 'completed';
        committeesStore.put(cRec);
      }
    },
  });

  return { paymentTransactionId: paymentRecord.id };
}

/**
 * Undoes a recorded cycle — reverses the payout (if any) AND the
 * contribution AND resets the cycle back to 'pending', all inside ONE
 * atomic transaction (previously the payout reversal was a separate outer
 * transaction, so a failure partway through could leave things
 * half-reversed — this version can't do that).
 */
export async function reverseCycle(cycleId, reason = '') {
  const cycle = await getById('committee_cycles', cycleId);
  if (!cycle) throw new ValidationError('Cycle not found.');
  if (cycle.status !== 'recorded') throw new ValidationError('This cycle has not been recorded yet.');

  await withTransaction(
    ['ledger', 'accounts', 'settings', 'people', 'committee_cycles', 'committees'],
    'readwrite',
    async (tx) => {
      if (cycle.payoutTransactionId) {
        await postLinkedReversal(tx, cycle.payoutTransactionId, reason);
      }
      await postLinkedReversal(tx, cycle.transactionId, reason);

      const cycleStore = tx.objectStore('committee_cycles');
      const c = await reqToPromise(cycleStore.get(cycleId));
      Object.assign(c, {
        status: 'pending',
        winningBid: 0,
        discountPerMembership: 0,
        payablePerMembership: 0,
        totalPayable: 0,
        payout: 0,
        userWon: false,
        winnerName: '',
        winnerMembershipId: null,
        userSaving: 0,
        transactionId: null,
        payoutTransactionId: null,
      });
      cycleStore.put(c);

      const committeesStore = tx.objectStore('committees');
      const cmt = await reqToPromise(committeesStore.get(cycle.committeeId));
      if (cmt.status === 'completed') {
        cmt.status = 'active';
        committeesStore.put(cmt);
      }
    }
  );
}
