import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OUTCOME, TOO_SOON_CODE, classifyError, classifyResult, exitCodeFor } from '../src/classify.js';

const HASH = '9xQd1YtW3cXrXk3ExampleHash1111111111111111';

function txResponse(status, receipts = []) {
  return {
    status,
    transaction: { hash: HASH },
    transaction_outcome: { id: HASH },
    receipts_outcome: receipts,
  };
}

// Shape of a contract panic as returned by the RPC in status.Failure.
function panicFailure(message) {
  return {
    ActionError: {
      index: 0,
      kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${message}` } },
    },
  };
}

describe('classifyResult', () => {
  it('treats SuccessValue as distributed and keeps the tx hash', () => {
    const r = classifyResult(txResponse({ SuccessValue: '' }));
    assert.equal(r.outcome, OUTCOME.DISTRIBUTED);
    assert.equal(r.txHash, HASH);
    assert.equal(r.failedReceipts, undefined);
  });

  it('counts failed receipts inside a successful transaction', () => {
    const r = classifyResult(
      txResponse({ SuccessValue: '' }, [
        { outcome: { status: { SuccessValue: '' } } },
        { outcome: { status: { Failure: panicFailure('storage not registered') } } },
      ]),
    );
    assert.equal(r.outcome, OUTCOME.DISTRIBUTED);
    assert.equal(r.failedReceipts, 1);
  });

  it(`treats a panic containing ${TOO_SOON_CODE} as too_soon`, () => {
    const r = classifyResult(txResponse({ Failure: panicFailure(`E07 ${TOO_SOON_CODE}: next at 1730000000`) }));
    assert.equal(r.outcome, OUTCOME.TOO_SOON);
    assert.equal(r.txHash, HASH);
  });

  it('treats any other failure as failed, with detail', () => {
    const r = classifyResult(txResponse({ Failure: panicFailure('Exceeded the prepaid gas') }));
    assert.equal(r.outcome, OUTCOME.FAILED);
    assert.match(r.detail, /prepaid gas/);
  });

  it('treats an unknown status as failed', () => {
    assert.equal(classifyResult(txResponse('Started')).outcome, OUTCOME.FAILED);
    assert.equal(classifyResult(undefined).outcome, OUTCOME.FAILED);
  });

  it('truncates very long failure detail', () => {
    const r = classifyResult(txResponse({ Failure: panicFailure('x'.repeat(5000)) }));
    assert.ok(r.detail.length <= 501);
  });
});

describe('classifyError', () => {
  it(`treats a thrown error mentioning ${TOO_SOON_CODE} as too_soon`, () => {
    const err = new Error(`Smart contract panicked: ${TOO_SOON_CODE}`);
    assert.equal(classifyError(err).outcome, OUTCOME.TOO_SOON);
  });

  it('finds the code in error context too', () => {
    const err = Object.assign(new Error('Transaction failed'), { context: { reason: TOO_SOON_CODE } });
    assert.equal(classifyError(err).outcome, OUTCOME.TOO_SOON);
  });

  it('treats network and allowance errors as failed', () => {
    assert.equal(classifyError(new Error('fetch failed')).outcome, OUTCOME.FAILED);
    const allowance = Object.assign(new Error('Access Key does not have enough allowance'), { type: 'NotEnoughAllowance' });
    const r = classifyError(allowance);
    assert.equal(r.outcome, OUTCOME.FAILED);
    assert.match(r.detail, /NotEnoughAllowance/);
  });

  it('handles non-Error throwables', () => {
    assert.equal(classifyError('boom').outcome, OUTCOME.FAILED);
    assert.equal(classifyError(undefined).outcome, OUTCOME.FAILED);
  });
});

describe('exitCodeFor', () => {
  const d = { outcome: OUTCOME.DISTRIBUTED };
  const s = { outcome: OUTCOME.TOO_SOON };
  const f = { outcome: OUTCOME.FAILED };

  it('is non-zero only when both calls failed', () => {
    assert.equal(exitCodeFor([f, f]), 1);
    assert.equal(exitCodeFor([d, f]), 0);
    assert.equal(exitCodeFor([f, s]), 0);
    assert.equal(exitCodeFor([s, s]), 0);
    assert.equal(exitCodeFor([d, d]), 0);
  });

  it('is non-zero when nothing ran', () => {
    assert.equal(exitCodeFor([]), 1);
  });
});
