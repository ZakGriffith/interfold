// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
// Minimal EIP-1193 wallet connection. The dashboard deliberately avoids a
// connector library (wagmi/rainbowkit): the operator guide only needs one
// provider, one chain, and a handful of writes. The provider is the injected
// browser wallet, or the hosting Safe when the page runs as a Safe App.

import { createWalletClient, custom, type Address, type Hash, type WalletClient } from 'viem'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { CHAIN, publicClient } from './chain'
import { explorerTx } from './links'
import { detectSafe, safeTxUrl, waitForSafeTx, type SafeContext, type SafeTxStage } from './safe'

type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<any>
  on?: (event: string, handler: (...args: any[]) => void) => void
  removeListener?: (event: string, handler: (...args: any[]) => void) => void
}

type ProviderSource = { kind: 'injected'; provider: Eip1193Provider } | { kind: 'safe'; provider: Eip1193Provider; safe: SafeContext }

export function getProvider(): Eip1193Provider | null {
  const injected = (globalThis as any).window?.ethereum
  return injected ?? null
}

// A Safe host answers within the detection timeout; any other page, embedded or
// not, falls through to the injected wallet.
async function resolveProvider(): Promise<ProviderSource | null> {
  const safe = await detectSafe()
  if (safe) return { kind: 'safe', provider: safe.provider as unknown as Eip1193Provider, safe }
  const injected = getProvider()
  return injected ? { kind: 'injected', provider: injected } : null
}

const toChainId = (value: unknown): number | null => {
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number.parseInt(value, 16)
  return null
}

/** A sent transaction that the page is still waiting on. */
export type PendingTx = {
  /** The on-chain hash, or the Safe transaction hash while the Safe holds it. */
  hash: Hash
  /** `mining` for an on-chain hash; the Safe queue stages otherwise. */
  stage: 'mining' | SafeTxStage
  /** Where to watch it: the block explorer, or the Safe transaction page. */
  url: string
}

export type Wallet = {
  /** True until the page knows whether a Safe hosts it. */
  detecting: boolean
  available: boolean
  address: Address | null
  chainId: number | null
  onCorrectChain: boolean
  connecting: boolean
  error: string | null
  connect: () => Promise<void>
  switchChain: () => Promise<void>
  /** Wallet client bound to the connected account, or null when disconnected. */
  client: WalletClient | null
  /** The hosting Safe, or null when the wallet is an injected provider. */
  safe: { address: Address; threshold: number; owners: number; chainName: string } | null
  /** Wait for a sent transaction and return its on-chain hash. Rejects on revert. */
  confirm: (hash: Hash) => Promise<Hash>
  pending: PendingTx | null
}

export function useWallet(): Wallet {
  // `undefined` while detecting, `null` when no provider exists.
  const [source, setSource] = useState<ProviderSource | null | undefined>(undefined)
  const [address, setAddress] = useState<Address | null>(null)
  const [chainId, setChainId] = useState<number | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingTx | null>(null)

  useEffect(() => {
    let cancelled = false
    void resolveProvider().then((resolved) => {
      if (!cancelled) setSource(resolved)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const provider = source?.provider ?? null

  // Pick up an already-authorized account on mount without prompting. A Safe
  // always reports its own address here, so a Safe App connects on load.
  useEffect(() => {
    if (!provider) return undefined
    let cancelled = false
    const load = async () => {
      try {
        const [accounts, hexChain] = await Promise.all([
          provider.request({ method: 'eth_accounts' }),
          provider.request({ method: 'eth_chainId' }),
        ])
        if (cancelled) return
        setAddress((accounts as Address[])[0] ?? null)
        setChainId(toChainId(hexChain))
      } catch {
        // A provider that refuses eth_accounts is simply treated as disconnected.
      }
    }
    void load()

    const onAccounts = (accounts: string[]) => setAddress((accounts[0] as Address) ?? null)
    const onChain = (hexChain: string) => setChainId(toChainId(hexChain))
    provider.on?.('accountsChanged', onAccounts)
    provider.on?.('chainChanged', onChain)
    return () => {
      cancelled = true
      provider.removeListener?.('accountsChanged', onAccounts)
      provider.removeListener?.('chainChanged', onChain)
    }
  }, [provider])

  const connect = useCallback(async () => {
    if (!provider) {
      setError('No Ethereum wallet detected. Install a browser wallet to continue.')
      return
    }
    setConnecting(true)
    setError(null)
    try {
      const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as Address[]
      setAddress(accounts[0] ?? null)
      setChainId(toChainId(await provider.request({ method: 'eth_chainId' })))
    } catch (e) {
      setError(walletErrorMessage(e))
    } finally {
      setConnecting(false)
    }
  }, [provider])

  const switchChain = useCallback(async () => {
    // A Safe lives on one chain; the operator opens the app from a Safe on the right one.
    if (!provider || source?.kind === 'safe') return
    setError(null)
    const hexId = `0x${CHAIN.id.toString(16)}`
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] })
      setChainId(CHAIN.id)
    } catch (e: any) {
      // 4902 = chain unknown to the wallet; offer to add it before switching.
      if (e?.code === 4902) {
        try {
          await provider.request({
            method: 'wallet_addEthereumChain',
            params: [
              {
                chainId: hexId,
                chainName: CHAIN.name,
                nativeCurrency: CHAIN.nativeCurrency,
                rpcUrls: [CHAIN.rpcUrls.default.http[0]],
                blockExplorerUrls: [CHAIN.blockExplorers?.default.url],
              },
            ],
          })
          setChainId(CHAIN.id)
          return
        } catch (addError) {
          setError(walletErrorMessage(addError))
          return
        }
      }
      setError(walletErrorMessage(e))
    }
  }, [provider, source])

  const confirm = useCallback(
    async (hash: Hash): Promise<Hash> => {
      try {
        if (source?.kind === 'safe') {
          const { safe } = source
          const url = safeTxUrl(safe, hash)
          setPending({ hash, stage: 'awaiting-confirmations', url })
          const onChain = await waitForSafeTx(safe.sdk.txs, hash, (stage) => setPending({ hash, stage, url }))
          await confirmTx(onChain)
          return onChain
        }
        setPending({ hash, stage: 'mining', url: explorerTx(hash) })
        await confirmTx(hash)
        return hash
      } finally {
        setPending(null)
      }
    },
    [source],
  )

  const client = useMemo(() => {
    if (!provider || !address) return null
    return createWalletClient({ account: address, chain: CHAIN, transport: custom(provider) })
  }, [provider, address])

  const safe = useMemo(() => {
    if (source?.kind !== 'safe') return null
    const { info, chain } = source.safe
    return {
      address: info.safeAddress as Address,
      threshold: info.threshold,
      owners: info.owners.length,
      chainName: chain.chainName,
    }
  }, [source])

  return {
    detecting: source === undefined,
    available: Boolean(provider),
    address,
    chainId,
    onCorrectChain: chainId === CHAIN.id,
    connecting,
    error,
    connect,
    switchChain,
    client,
    safe,
    confirm,
    pending,
  }
}

// Wallet and node errors are deeply nested and noisy. Surface the shortest
// message a human can act on, and keep custom-error names (the bonding registry
// reverts with typed errors such as `NotBondOwner`).
export function walletErrorMessage(e: unknown): string {
  const err = e as any
  if (err?.code === 4001 || /user rejected|denied transaction/i.test(String(err?.message ?? ''))) {
    return 'Transaction rejected in the wallet.'
  }
  const revertName = err?.cause?.data?.errorName ?? err?.data?.errorName
  if (typeof revertName === 'string') return `Reverted: ${revertName}`
  const short = err?.shortMessage ?? err?.details ?? err?.message
  if (typeof short === 'string' && short.trim() !== '') return short.split('\n')[0]
  return 'Something went wrong. Check the wallet and try again.'
}

/** Wait for a submitted on-chain transaction and reject when it reverted. */
async function confirmTx(hash: Hash): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error('Transaction reverted on-chain.')
}
