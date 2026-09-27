/**
 * Talks to Cashfree SANDBOX with the keys in .env, through the same code the API uses:
 * creates a test order, reads its payments, creates a test payee (beneficiary) and sends it ₹1.
 * Refuses to run with CASHFREE_ENV=production. Prints no secrets.
 *
 *   npx ts-node --transpile-only scripts/cashfree-sandbox-check.ts
 */
import { randomUUID } from 'node:crypto';

import { loadDotEnvForLocal, loadEnv } from '../src/config/env';
import { CashfreeGateway, cashfreeId } from '../src/infra/payments/gateway';
import { CashfreePayouts } from '../src/infra/payments/payouts';

loadDotEnvForLocal();

async function main() {
  const env = loadEnv();
  if (env.CASHFREE_ENV !== 'sandbox') throw new Error('Only for CASHFREE_ENV=sandbox.');

  const pg = new CashfreeGateway(env);
  const order = await pg.createOrder({
    orderId: cashfreeId('op', randomUUID()),
    amountPaise: 100,
    customer: { id: 'u_sandbox_check', phone: '9999999999' },
    returnUrl: 'https://opflow-backend.onrender.com/v1/payments/return?b=00000000-0000-0000-0000-000000000000&to=https%3A%2F%2Fopflow-alpha.vercel.app&order_id={order_id}',
    note: 'OPflow sandbox check',
    expiresAt: new Date(Date.now() + 20 * 60_000),
  });
  console.log('PG order created:', order.id, `(₹${order.amount / 100}, session ${order.sessionId ? 'received' : 'MISSING'})`);
  const attempts = await pg.fetchOrderPayments(order.id);
  console.log('PG payments on the new order:', attempts.length, '(expected 0 before anyone pays)');

  const po = new CashfreePayouts(env);
  const benId = `doc_sandboxcheck_${Date.now().toString(36)}`;
  const ben = await po.createBeneficiary({ id: benId, name: 'Sandbox Doctor', accountNumber: '026291800001191', ifsc: 'YESB0000262', phone: '9999999999', email: null });
  console.log('Payouts beneficiary:', benId, '→', ben);
  const again = await po.beneficiaryStatus(benId);
  console.log('Payouts beneficiary status (read back):', again);
  if (ben !== 'invalid') {
    const tid = cashfreeId('po', randomUUID());
    try {
      const t = await po.transfer(tid, benId, 100, 'OPflow sandbox check');
      console.log('Payouts ₹1 transfer:', t.status, t.utr ? '(bank ref received)' : '');
      const s = await po.transferStatus(tid);
      console.log('Payouts transfer status (read back):', s.status);
    } catch (err) {
      console.log('Payouts transfer not made:', (err as Error).message.split('\n')[0]);
    }
  }
}

main().catch((err: unknown) => {
  console.error('FAILED:', err instanceof Error ? err.message.split('\n')[0] : err);
  process.exit(1);
});
