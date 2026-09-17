'use strict';

/**
 * Runs `worker` over `items` with at most `limit` in flight at once.
 * Results are returned in input order regardless of completion order.
 *
 * Scenarios are independent (their own context, own TUIs) so they are safe
 * to overlap, but the live Akbar API throttles auth (Signature Code 800)
 * under too much concurrent load — so this stays a small bounded pool
 * rather than Promise.all.
 */
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function runNext() {
    const i = next++;
    if (i >= items.length) return;
    results[i] = await worker(items[i], i);
    return runNext();
  }

  const poolSize = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: poolSize }, runNext));
  return results;
}

module.exports = { runWithConcurrency };
