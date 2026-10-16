// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import assert from 'node:assert/strict'
import test from 'node:test'
import { TransactionStatus } from '@safe-global/safe-apps-sdk'
import { waitForSafeTx, type SafeTxLookup } from './safe'

const SAFE_TX_HASH = `0x${'a'.repeat(64)}` as const
const ON_CHAIN_HASH = `0x${'b'.repeat(64)}` as const

// Each entry is one transaction-service answer, in order; `null` is a lookup error.
const lookups = (answers: Array<{ txStatus: TransactionStatus; txHash?: string } | null>): SafeTxLookup => {
  let i = 0
  return {
    getBySafeTxHash: async () => {
      const answer = answers[Math.min(i++, answers.length - 1)]
      if (!answer) throw new Error('not indexed yet')
      return answer as any
    },
  }
}

test('resolves with the on-chain hash only after the Safe executes, reporting each queue stage once', async () => {
  const stages: string[] = []
  const txs = lookups([
    null,
    { txStatus: TransactionStatus.AWAITING_CONFIRMATIONS },
    { txStatus: TransactionStatus.AWAITING_CONFIRMATIONS },
    { txStatus: TransactionStatus.AWAITING_EXECUTION },
    // The gateway can flip to SUCCESS before it has the executing transaction's hash.
    { txStatus: TransactionStatus.SUCCESS },
    { txStatus: TransactionStatus.SUCCESS, txHash: ON_CHAIN_HASH },
  ])
  const hash = await waitForSafeTx(txs, SAFE_TX_HASH, (s) => stages.push(s), 0)
  assert.equal(hash, ON_CHAIN_HASH)
  assert.deepEqual(stages, ['awaiting-confirmations', 'awaiting-execution'])
})

test('rejects when an owner rejects the Safe transaction', async () => {
  const txs = lookups([{ txStatus: TransactionStatus.CANCELLED }])
  await assert.rejects(
    waitForSafeTx(txs, SAFE_TX_HASH, () => {}, 0),
    /rejected or replaced/,
  )
})

test('rejects when the Safe transaction failed on-chain', async () => {
  const txs = lookups([{ txStatus: TransactionStatus.FAILED, txHash: ON_CHAIN_HASH }])
  await assert.rejects(
    waitForSafeTx(txs, SAFE_TX_HASH, () => {}, 0),
    /failed on-chain/,
  )
})
