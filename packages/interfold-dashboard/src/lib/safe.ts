// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
// Safe App support. Inside the Safe web UI the dashboard runs in an iframe and
// the Safe is the connected wallet: the Safe Apps SDK answers EIP-1193 requests,
// and `eth_sendTransaction` returns a Safe transaction hash that only becomes an
// on-chain transaction after enough owners confirm it.

import SafeAppsSDK, { TransactionStatus, type ChainInfo, type SafeInfo } from '@safe-global/safe-apps-sdk'
import { SafeAppProvider } from '@safe-global/safe-apps-provider'
import type { Hash } from 'viem'

export type SafeContext = {
  sdk: SafeAppsSDK
  info: SafeInfo
  chain: ChainInfo
  provider: SafeAppProvider
}

/** True when another origin embeds the page, which is the only way a Safe App loads. */
export function inIframe(): boolean {
  const w = (globalThis as any).window
  if (!w) return false
  try {
    return w.self !== w.top
  } catch {
    // A cross-origin parent denies access to `top`, which proves the page is embedded.
    return true
  }
}

// The SDK posts a message to the parent and waits for the reply. A parent that is
// not Safe never answers, so detection needs a timeout.
const SAFE_DETECT_TIMEOUT_MS = 1000

/** Resolve the Safe that hosts the page, or null when the page is not a Safe App. */
export async function detectSafe(timeoutMs = SAFE_DETECT_TIMEOUT_MS): Promise<SafeContext | null> {
  if (!inIframe()) return null
  const sdk = new SafeAppsSDK()
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))
  const info = await Promise.race([sdk.safe.getInfo(), timeout])
  if (!info) return null
  const chain = await sdk.safe.getChainInfo()
  return { sdk, info, chain, provider: new SafeAppProvider(info, sdk) }
}

export type SafeTxStage = 'awaiting-confirmations' | 'awaiting-execution'

export type SafeTxLookup = Pick<SafeAppsSDK['txs'], 'getBySafeTxHash'>

const SAFE_POLL_INTERVAL_MS = 5000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Wait until the Safe transaction executes and return its on-chain hash.
 * A multi-owner Safe can hold the transaction in its queue for hours, so the
 * caller gets each stage change to show. Rejects when the Safe reports failure
 * or when an owner rejects or replaces the transaction.
 */
export async function waitForSafeTx(
  txs: SafeTxLookup,
  safeTxHash: Hash,
  onStage: (stage: SafeTxStage) => void,
  intervalMs = SAFE_POLL_INTERVAL_MS,
): Promise<Hash> {
  let stage: SafeTxStage | null = null
  const report = (next: SafeTxStage) => {
    if (next === stage) return
    stage = next
    onStage(next)
  }
  for (;;) {
    let status: TransactionStatus | null = null
    let txHash: string | undefined
    try {
      const details = await txs.getBySafeTxHash(safeTxHash)
      status = details.txStatus
      txHash = details.txHash
    } catch {
      // The transaction service indexes a new proposal with a short delay; a
      // lookup error in that window means "not yet", not failure.
    }
    switch (status) {
      case TransactionStatus.SUCCESS:
        if (txHash) return txHash as Hash
        break
      case TransactionStatus.FAILED:
        throw new Error('The Safe transaction failed on-chain.')
      case TransactionStatus.CANCELLED:
        throw new Error('The Safe transaction was rejected or replaced in the Safe.')
      case TransactionStatus.AWAITING_EXECUTION:
        report('awaiting-execution')
        break
      case TransactionStatus.AWAITING_CONFIRMATIONS:
        report('awaiting-confirmations')
        break
      default:
        break
    }
    await sleep(intervalMs)
  }
}

/** Link to the transaction in the Safe web UI, where other owners confirm it. */
export function safeTxUrl(safe: Pick<SafeContext, 'info' | 'chain'>, safeTxHash: string): string {
  const address = safe.info.safeAddress
  const target = `${safe.chain.shortName}:${address}`
  return `https://app.safe.global/transactions/tx?safe=${target}&id=multisig_${address}_${safeTxHash}`
}
