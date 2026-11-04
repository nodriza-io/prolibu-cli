'use strict';

// Which proposal model an account runs.
//
//   "deal"    — the proposal lives inside the deal (`deal.proposal`, `deal.proposalVersions`).
//   "records" — proposals are their own records (`/v2/proposal`), several per deal, each with a
//               status (Draft, Ready, Approved, Denied) and automatic ProposalVersion snapshots.
//
// The signal is the base CRUD the server generates for every registered model: an account
// without the Proposal model answers 404 to GET /v2/proposal (verified on a deal-model account, 3 nov 2026).
// 401/403 mean the model exists but this key cannot list it.

const cache = new WeakMap();

async function detectModel(client) {
  if (cache.has(client)) return cache.get(client);
  const res = await client.request('GET', '/v2/proposal?limit=1&select=_id');
  let result;
  if (res.status === 404) result = { model: 'deal', evidence: 'GET /v2/proposal answered 404: the account has no Proposal model.' };
  else if (res.ok) result = { model: 'records', evidence: 'GET /v2/proposal answered 200: proposals are their own records.' };
  else if (res.status === 401 || res.status === 403) {
    result = { model: 'records', evidence: `GET /v2/proposal answered ${res.status}: the model exists but this key cannot list proposals.`, noAccess: true };
  } else {
    const err = new Error(`GET /v2/proposal answered ${res.status}: could not tell which proposal model the account runs.`);
    err.status = res.status;
    throw err;
  }
  cache.set(client, result);
  return result;
}

module.exports = { detectModel };
