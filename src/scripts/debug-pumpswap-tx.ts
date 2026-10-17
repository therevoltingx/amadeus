/**
 * One-off debug: fetch a specific tx (base64 + jsonParsed), inspect inner instructions and run parser.
 * Usage: HELIUS_RPC_URL=... npx tsx src/scripts/debug-pumpswap-tx.ts [signature]
 */
import 'dotenv/config';
import { VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { PUMP_SWAP_PROGRAM_ID, parsePumpSwapSwapInstructionsFromTx } from '../pumpswap-rpc-parser.js';

const SIG =
  process.argv[2] ??
  '576JhsbPWRUNfNbv2HJLFwUdd9ELVF6UpEUEs4uGFikNsGn3yg2wFaMS5iRTu4ipPGBfNDMTR87wdY6ps3WiQQcW';
const RPC = process.env.HELIUS_RPC_URL;

function toBase58(key: unknown): string {
  if (typeof key === 'string') return key;
  if (key != null && typeof key === 'object') {
    const o = key as Record<string, unknown>;
    if (typeof o.toBase58 === 'function') return (o.toBase58 as () => string)();
    if (typeof o.pubkey === 'string') return o.pubkey;
  }
  return '';
}

async function main() {
  if (!RPC) {
    console.error('Set HELIUS_RPC_URL');
    process.exit(1);
  }

  const fetchTx = async (encoding: 'base64' | 'jsonParsed') => {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        method: 'getTransaction',
        params: [SIG, { encoding, maxSupportedTransactionVersion: 0, commitment: 'confirmed' }],
      }),
    });
    const data = await res.json();
    return data.result as Record<string, unknown> | null;
  };

  console.log('Fetching tx (base64)...');
  const base = await fetchTx('base64');
  console.log('Fetching tx (jsonParsed)...');
  const parsed = await fetchTx('jsonParsed');

  const metaBase = base?.meta as Record<string, unknown> | undefined;
  const metaParsed = parsed?.meta as Record<string, unknown> | undefined;
  const innerBase = (metaBase?.innerInstructions ?? metaBase?.inner_instructions) as unknown[] | undefined;
  const innerParsed = (metaParsed?.innerInstructions ?? metaParsed?.inner_instructions) as unknown[] | undefined;

  console.log('\n--- base64 response ---');
  console.log('meta.innerInstructions length:', innerBase?.length ?? 0);
  if (Array.isArray(innerBase) && innerBase.length > 0) {
    const first = innerBase[0] as Record<string, unknown>;
    const ixs = (first.instructions ?? first.instructions) as unknown[] | undefined;
    console.log('first block keys:', Object.keys(first));
    console.log('first block.instructions length:', ixs?.length ?? 0);
    if (ixs?.length) {
      const ix0 = ixs[0] as Record<string, unknown>;
      console.log('first inner ix keys:', Object.keys(ix0));
      console.log('first inner ix.data type:', typeof ix0?.data, ix0?.data ? (String(ix0.data).slice(0, 40) + '...') : '');
      console.log('first inner ix.accounts type:', Array.isArray(ix0?.accounts) ? 'array len ' + (ix0.accounts as unknown[]).length : typeof ix0?.accounts);
      if (Array.isArray(ix0?.accounts)) console.log('first account[0]:', typeof (ix0.accounts as unknown[])[0], (ix0.accounts as unknown[])[0]);
    }
  }

  console.log('\n--- jsonParsed response ---');
  console.log('meta.innerInstructions length:', innerParsed?.length ?? 0);
  if (Array.isArray(innerParsed) && innerParsed.length > 0) {
    const first = innerParsed[0] as Record<string, unknown>;
    const ixs = (first.instructions ?? first.instructions) as unknown[] | undefined;
    console.log('first block keys:', Object.keys(first));
    console.log('first block.instructions length:', ixs?.length ?? 0);
    if (ixs?.length) {
      const ix0 = ixs[0] as Record<string, unknown>;
      console.log('first inner ix keys:', Object.keys(ix0));
      console.log('first inner ix.data type:', typeof ix0?.data, ix0?.data ? (String(ix0.data).slice(0, 40) + '...') : '');
      console.log('first inner ix.parsed?.data type:', ix0?.parsed != null ? typeof (ix0.parsed as Record<string, unknown>)?.data : 'no parsed');
      console.log('first inner ix.accounts type:', Array.isArray(ix0?.accounts) ? 'array len ' + (ix0.accounts as unknown[]).length : typeof ix0?.accounts);
      if (Array.isArray(ix0?.accounts)) console.log('first account[0]:', typeof (ix0.accounts as unknown[])[0], String((ix0.accounts as unknown[])[0]).slice(0, 20) + '...');
    }
  }

  if (!base?.transaction) {
    console.log('\nNo base64 transaction; cannot run full payload build.');
    return;
  }

  let txRaw = base.transaction as string | string[];
  if (Array.isArray(txRaw) && typeof txRaw[0] === 'string') txRaw = txRaw[0];
  if (typeof txRaw !== 'string') return;

  const buf = Buffer.from(txRaw, 'base64');
  const versionedTx = VersionedTransaction.deserialize(buf);
  const msg = versionedTx.message;
  const keysObj = (msg as { getAccountKeys(): { keySegments(): unknown[][] } }).getAccountKeys?.();
  if (!keysObj?.keySegments) {
    console.log('\nNo getAccountKeys/keySegments');
    return;
  }
  const staticKeys = keysObj.keySegments().flat().map((k: unknown) => toBase58(k));
  const loaded = (metaBase?.loadedAddresses ?? {}) as { writable?: unknown[]; readonly?: unknown[] };
  const writable = (loaded.writable ?? []).map((k: unknown) => toBase58(k));
  const readonly = (loaded.readonly ?? []).map((k: unknown) => toBase58(k));
  const accountKeys = writable.length > 0 || readonly.length > 0 ? [...staticKeys, ...writable, ...readonly] : staticKeys;
  const rawIxs = (msg as { compiledInstructions?: Array<{ programIdIndex: number; accountKeyIndexes?: number[]; accounts?: number[] | Uint8Array; data: Uint8Array }> }).compiledInstructions;
  if (!Array.isArray(rawIxs)) {
    console.log('\nNo compiledInstructions');
    return;
  }

  const topLevel = rawIxs.map((ix) => {
    const accountIndices = ix.accountKeyIndexes ?? (Array.isArray(ix.accounts) ? ix.accounts : ix.accounts instanceof Uint8Array ? Array.from(ix.accounts) : []);
    return {
      programIdIndex: ix.programIdIndex,
      accountKeyIndexes: accountIndices,
      data: Buffer.from(ix.data).toString('base64'),
    };
  });

  let meta = metaBase ?? null;
  if ((meta?.innerInstructions?.length ?? 0) === 0 && (meta && (meta as { inner_instructions?: unknown[] }).inner_instructions?.length) === 0) {
    const parsedInner = (metaParsed?.innerInstructions ?? metaParsed?.inner_instructions) as Array<{ instructions?: unknown[] }> | undefined;
    if (parsedInner?.length) {
      meta = meta ? { ...meta, innerInstructions: parsedInner } : ({ loadedAddresses: undefined, innerInstructions: parsedInner } as typeof meta);
      console.log('\nMerged jsonParsed inner instructions into meta:', parsedInner.length, 'blocks');
    }
  }

  const innerBlocks = (meta?.innerInstructions ?? (meta as { inner_instructions?: Array<{ instructions?: unknown[] }> })?.inner_instructions) ?? [];
  const innerFlat = innerBlocks.flatMap((block: { instructions?: unknown[] }) => block.instructions ?? []) as Array<Record<string, unknown>>;
  console.log('\nTotal inner instructions (after merge):', innerFlat.length);

  const normalizedInner: Array<{ programIdIndex: number; accountKeyIndexes?: number[]; accounts?: unknown[]; data?: string }> = [];
  for (const ix of innerFlat) {
    const programKey = (ix.program as string) ?? (ix.programIdIndex != null ? accountKeys[ix.programIdIndex as number] : null);
    if (!programKey) continue;
    const programIdIndex = typeof ix.programIdIndex === 'number' ? ix.programIdIndex : accountKeys.indexOf(programKey);
    if (programIdIndex < 0) continue;
    const rawData = ix.data ?? (ix.parsed as Record<string, unknown>)?.data;
    if (rawData == null || typeof rawData !== 'string') {
      if (programKey === PUMP_SWAP_PROGRAM_ID) console.log('  Skip PumpSwap inner ix: no string data', { hasData: !!ix.data, hasParsedData: !!(ix.parsed as Record<string, unknown>)?.data });
      continue;
    }
    const accounts = ix.accountKeyIndexes ?? ix.account_key_indexes ?? ix.accounts;
    const accountKeyIndexes = Array.isArray(accounts) && (accounts as number[]).every((n) => typeof n === 'number') ? (accounts as number[]) : undefined;
    normalizedInner.push({
      programIdIndex,
      accountKeyIndexes: accountKeyIndexes,
      accounts: Array.isArray(accounts) ? accounts : undefined,
      data: rawData,
    });
  }
  console.log('Normalized inner instructions (with string data):', normalizedInner.length);
  const pumpswapInners = normalizedInner.filter((ix) => accountKeys[ix.programIdIndex] === PUMP_SWAP_PROGRAM_ID);
  console.log('PumpSwap inner instructions:', pumpswapInners.length);
  if (pumpswapInners.length > 0) {
    const pi = pumpswapInners[0]!;
    const poolIdx = (pi.accountKeyIndexes ?? pi.accounts)?.[0];
    const poolAddr =
      poolIdx == null
        ? ''
        : typeof poolIdx === 'string'
          ? poolIdx
          : typeof poolIdx === 'number'
            ? accountKeys[poolIdx] ?? '(out of bounds)'
            : String(poolIdx);
    console.log('  First PumpSwap inner: programIdIndex=', pi.programIdIndex, 'accountKeyIndexes=', pi.accountKeyIndexes, 'accounts=', pi.accounts, 'poolIdx=', poolIdx, 'resolved pool=', poolAddr);
    if (pi.data) {
      let buf: Buffer;
      try {
        buf = /^[A-Za-z0-9+/]+=*$/.test(pi.data) ? Buffer.from(pi.data, 'base64') : Buffer.from(bs58.decode(pi.data));
      } catch {
        buf = Buffer.alloc(0);
      }
      console.log('  data length=', buf.length, 'first 8 bytes hex=', buf.subarray(0, 8).toString('hex'));
      if (buf.length >= 16) {
        const lo = buf.readUInt32LE(8);
        const hi = buf.readUInt32LE(12);
        const amount = hi * 0x1_0000_0000 + lo;
        console.log('  amount (u64 at offset 8)=', amount);
      }
    }
  }

  const compiledInstructions = [...topLevel, ...normalizedInner];
  const message = { accountKeys, compiledInstructions, instructions: compiledInstructions };
  const loadedAddresses = (meta as Record<string, unknown>)?.loadedAddresses as { writable?: unknown[]; readonly?: unknown[] } | undefined ?? null;
  const swaps = parsePumpSwapSwapInstructionsFromTx(message as Parameters<typeof parsePumpSwapSwapInstructionsFromTx>[0], loadedAddresses ?? null, meta as Parameters<typeof parsePumpSwapSwapInstructionsFromTx>[2]);
  console.log('\nParser result swaps (no sideFromLog):', swaps.length);
  if (swaps.length) console.log('Pairs:', [...new Set(swaps.map((s) => s.poolAddress))]);
  const swapsWithSide = parsePumpSwapSwapInstructionsFromTx(message as Parameters<typeof parsePumpSwapSwapInstructionsFromTx>[0], loadedAddresses ?? null, meta as Parameters<typeof parsePumpSwapSwapInstructionsFromTx>[2], { sideFromLog: 'buy' });
  console.log('Parser result swaps (sideFromLog=buy):', swapsWithSide.length);
  if (swapsWithSide.length) console.log('Pairs:', [...new Set(swapsWithSide.map((s) => s.poolAddress))]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
