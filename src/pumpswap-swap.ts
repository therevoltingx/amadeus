/**
 * PumpSwap AMM swap — manual instruction builder.
 * No external SDK dependency; reads pool account on-chain for authoritative
 * base/quote mints and creator, then builds Buy or Sell instructions directly.
 *
 * Account layouts (per the official @pump-fun/pump-swap-sdk):
 *   Buy:  23 named accounts (0–22, volume accumulators at 19–20)
 *         + remaining_accounts: [poolV2Pda] or [userVolAccumWsolAta, poolV2Pda] (cashback)
 *   Sell: 21 named accounts (0–20, no volume accumulators)
 *         + remaining_accounts: [poolV2Pda] or [userVolAccumQuoteAta, userVolAccum, poolV2Pda] (cashback)
 *
 * AMM formulas match the official SDK:
 *   Buy  (buyQuoteInput): tokenOut = baseReserve * effectiveQuote / (quoteReserve + effectiveQuote)
 *   Sell (sellBaseInput):  solOut  = quoteReserve * tokenIn / (baseReserve + tokenIn), minus fees
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import { isBase58, sanitizeToBase58 } from './validators/address.js';
import { WSOL_MINT } from './pumpswap-rpc-parser.js';
import type { ExecutionOrder } from './executors/types.js';

const LAMPORTS_PER_SOL = 1e9;

const PUMP_SWAP_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const FEE_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
const PROTOCOL_FEE_RECIPIENT = new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');
const WSOL_PK = new PublicKey(WSOL_MINT);

const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);
const EXTEND_ACCOUNT_DISCRIMINATOR = Buffer.from([234, 102, 194, 203, 150, 72, 62, 229]);

// ── Pool V2 PDA ─────────────────────────────────────────────────────────────
// Per the official SDK, Buy and Sell instructions always pass a `pool-v2` PDA
// as the last remaining_account. This enables the newer on-chain code path
// (avoids u64 overflow in volume tracking for creator-fee pools).

function derivePoolV2(baseMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool-v2'), baseMint.toBuffer()],
    PUMP_SWAP_PROGRAM_ID,
  )[0];
}

const POOL_ACCOUNT_NEW_SIZE = 300;

const FEE_CONFIG_MAGIC = Buffer.from([
  12, 20, 222, 252, 130, 94, 198, 118, 148, 37, 8, 24, 187, 101, 64, 101,
  244, 41, 141, 49, 86, 213, 113, 180, 212, 248, 9, 12, 24, 233, 168, 99,
]);

// Conservative total fee estimate (LP + protocol + creator) in bps.
// Real fees vary by tier (e.g. 2+93+30 = 125 bps); 150 bps is a safe upper bound
// so we slightly underestimate tokenOut on buys and slightly reduce minSolOut on sells.
const ESTIMATED_TOTAL_FEE_BPS = 150n;

// ── PDA helpers ─────────────────────────────────────────────────────────────

function deriveGlobalConfig(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('global_config')],
    PUMP_SWAP_PROGRAM_ID,
  )[0];
}

function deriveFeeConfig(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('fee_config'), FEE_CONFIG_MAGIC],
    FEE_PROGRAM_ID,
  )[0];
}

function deriveEventAuthority(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    PUMP_SWAP_PROGRAM_ID,
  )[0];
}

function deriveCreatorVaultAuthority(creatorPk: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('creator_vault'), creatorPk.toBuffer()],
    PUMP_SWAP_PROGRAM_ID,
  )[0];
}

function deriveCreatorVaultAta(creatorVaultAuthority: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      creatorVaultAuthority.toBuffer(),
      tokenProgram.toBuffer(),
      mint.toBuffer(),
    ],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

function deriveGlobalVolumeAccumulator(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('global_volume_accumulator')],
    PUMP_SWAP_PROGRAM_ID,
  )[0];
}

function deriveUserVolumeAccumulator(user: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user_volume_accumulator'), user.toBuffer()],
    PUMP_SWAP_PROGRAM_ID,
  )[0];
}

// ── Public interface ────────────────────────────────────────────────────────

export interface BuildPumpSwapSwapOptions {
  connection: Connection;
  signer: Keypair;
  mint: PublicKey;
  pairAddress: string;
  order: ExecutionOrder;
  slippageBps: number;
  getSolPriceUsd: () => Promise<number>;
}

/**
 * Build a PumpSwap AMM swap transaction (buy or sell).
 * Reads the pool account on-chain for authoritative base/quote mints and creator,
 * then derives all PDAs and builds instructions directly.
 */
export async function buildPumpSwapSwap(
  options: BuildPumpSwapSwapOptions,
): Promise<Transaction> {
  const { connection, signer, mint, pairAddress, order, slippageBps, getSolPriceUsd } = options;

  // ── Validate pair address ───────────────────────────────────────────────
  let pairClean = (pairAddress ?? '').trim();
  if (!isBase58(pairClean)) {
    pairClean = sanitizeToBase58(pairClean);
    if (pairClean.length < 32) throw new Error('Non-base58 character in pair_address');
  }
  if (!pairClean) throw new Error('Non-base58 character in pair_address');

  const poolKey = new PublicKey(pairClean);

  // ── Read pool account to get authoritative fields ──────────────────────
  const POOL_BASE_MINT_OFFSET = 43;
  const POOL_QUOTE_MINT_OFFSET = 75;
  const POOL_BASE_VAULT_OFFSET = 139;
  const POOL_QUOTE_VAULT_OFFSET = 171;
  const POOL_COIN_CREATOR_OFFSET = 211;
  const POOL_IS_MAYHEM_MODE_OFFSET = 243;
  const POOL_IS_CASHBACK_COIN_OFFSET = 244;

  const poolAccountInfo = await connection.getAccountInfo(poolKey);
  if (!poolAccountInfo?.data || poolAccountInfo.data.length < 243) {
    throw new Error(`SOLANA_SWAP_POOL_NOT_FOUND: pair=${pairClean} — pool account missing or too small`);
  }

  const poolData = poolAccountInfo.data;
  const baseMint = new PublicKey(poolData.subarray(POOL_BASE_MINT_OFFSET, POOL_BASE_MINT_OFFSET + 32));
  const quoteMint = new PublicKey(poolData.subarray(POOL_QUOTE_MINT_OFFSET, POOL_QUOTE_MINT_OFFSET + 32));
  const poolBaseVault = new PublicKey(poolData.subarray(POOL_BASE_VAULT_OFFSET, POOL_BASE_VAULT_OFFSET + 32));
  const poolQuoteVault = new PublicKey(poolData.subarray(POOL_QUOTE_VAULT_OFFSET, POOL_QUOTE_VAULT_OFFSET + 32));
  const coinCreator = new PublicKey(poolData.subarray(POOL_COIN_CREATOR_OFFSET, POOL_COIN_CREATOR_OFFSET + 32));
  const isCashbackCoin = poolData.length > POOL_IS_CASHBACK_COIN_OFFSET && poolData[POOL_IS_CASHBACK_COIN_OFFSET] === 1;

  const isBuy = order.signal?.toUpperCase() === 'BUY' || order.signal?.toUpperCase() !== 'SELL';

  const solSide = baseMint.equals(WSOL_PK) ? 'base' : quoteMint.equals(WSOL_PK) ? 'quote' : null;
  if (!solSide) {
    throw new Error(
      `SOLANA_SWAP_PUMPSWAP_NO_SOL_SIDE: Neither base nor quote is SOL/WSOL. pair=${pairClean} base=${baseMint.toBase58()} quote=${quoteMint.toBase58()}`,
    );
  }

  // ── Detect token programs (WSOL is always TOKEN_PROGRAM_ID) ────────────
  const nonSolMint = solSide === 'base' ? quoteMint : baseMint;
  const [baseBal, quoteBal, nonSolMintInfo] = await Promise.all([
    connection.getTokenAccountBalance(poolBaseVault),
    connection.getTokenAccountBalance(poolQuoteVault),
    connection.getAccountInfo(nonSolMint),
  ]);

  const nonSolTokenProgram =
    nonSolMintInfo?.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;

  const baseTokenProgram = solSide === 'base' ? TOKEN_PROGRAM_ID : nonSolTokenProgram;
  const quoteTokenProgram = solSide === 'base' ? nonSolTokenProgram : TOKEN_PROGRAM_ID;

  // ── Shared account derivations ──────────────────────────────────────────
  const user = signer.publicKey;
  const globalConfig = deriveGlobalConfig();
  const feeConfig = deriveFeeConfig();
  const eventAuthority = deriveEventAuthority();
  const userBaseAta = getAssociatedTokenAddressSync(baseMint, user, false, baseTokenProgram);
  const userQuoteAta = getAssociatedTokenAddressSync(quoteMint, user, false, quoteTokenProgram);
  const protocolFeeRecipientAta = getAssociatedTokenAddressSync(quoteMint, PROTOCOL_FEE_RECIPIENT, true, quoteTokenProgram);

  const creatorVaultAuthority = deriveCreatorVaultAuthority(coinCreator);
  const creatorVaultAta = deriveCreatorVaultAta(creatorVaultAuthority, quoteMint, quoteTokenProgram);

  const userVolumeAccumulator = deriveUserVolumeAccumulator(user);
  const userVolAccumWsolAta = getAssociatedTokenAddressSync(
    WSOL_PK,
    userVolumeAccumulator,
    true,
    TOKEN_PROGRAM_ID,
  );

  // Buy instruction: 23 named accounts (positions 0–22) including volume accumulators.
  // Sell instruction: 21 named accounts (positions 0–20), no volume accumulators.
  // Both append fee_config + fee_program after the base 17/19 accounts.
  const buyExtraKeys = [
    { pubkey: deriveGlobalVolumeAccumulator(), isSigner: false, isWritable: false },
    { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
    { pubkey: feeConfig, isSigner: false, isWritable: false },
    { pubkey: FEE_PROGRAM_ID, isSigner: false, isWritable: false },
  ] as const;

  const sellExtraKeys = [
    { pubkey: feeConfig, isSigner: false, isWritable: false },
    { pubkey: FEE_PROGRAM_ID, isSigner: false, isWritable: false },
  ] as const;

  const poolV2Pda = derivePoolV2(baseMint);

  // Per the official SDK, remaining_accounts always include poolV2Pda (read-only).
  // For cashback coins, Buy also prepends userVolAccumWsolAta; Sell also prepends
  // the quote-token ATA of the volume accumulator + the volume accumulator PDA.
  const buyRemainingAccounts = isCashbackCoin
    ? [
        { pubkey: userVolAccumWsolAta, isSigner: false, isWritable: true },
        { pubkey: poolV2Pda, isSigner: false, isWritable: false },
      ]
    : [{ pubkey: poolV2Pda, isSigner: false, isWritable: false }];

  const userVolAccumQuoteAta = getAssociatedTokenAddressSync(
    quoteMint,
    userVolumeAccumulator,
    true,
    quoteTokenProgram,
  );

  const sellRemainingAccounts = isCashbackCoin
    ? [
        { pubkey: userVolAccumQuoteAta, isSigner: false, isWritable: true },
        { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
        { pubkey: poolV2Pda, isSigner: false, isWritable: false },
      ]
    : [{ pubkey: poolV2Pda, isSigner: false, isWritable: false }];

  // ── Pool reserves (use pool's base/quote directly — NOT remapped) ──────
  const baseReserve = BigInt(baseBal.value.amount);
  const quoteReserve = BigInt(quoteBal.value.amount);
  if (baseReserve <= 0n || quoteReserve <= 0n) {
    throw new Error(`SOLANA_SWAP_INVALID_RESERVES: pair=${pairClean} base=${baseReserve} quote=${quoteReserve}`);
  }

  const tokenMint = solSide === 'base' ? quoteMint : baseMint;
  const userSolAta = solSide === 'base' ? userBaseAta : userQuoteAta;
  const userTokenAta = solSide === 'base' ? userQuoteAta : userBaseAta;

  const instructions: TransactionInstruction[] = [];

  if (poolData.length < POOL_ACCOUNT_NEW_SIZE) {
    const extendData = Buffer.alloc(8);
    EXTEND_ACCOUNT_DISCRIMINATOR.copy(extendData, 0);
    instructions.push(
      new TransactionInstruction({
        programId: PUMP_SWAP_PROGRAM_ID,
        keys: [
          { pubkey: poolKey, isSigner: false, isWritable: true },
          { pubkey: user, isSigner: true, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: eventAuthority, isSigner: false, isWritable: false },
          { pubkey: PUMP_SWAP_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: extendData,
      }),
    );
  }

  function swapKeys(extraKeys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]) {
    return [
      { pubkey: poolKey, isSigner: false, isWritable: true },
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: globalConfig, isSigner: false, isWritable: false },
      { pubkey: baseMint, isSigner: false, isWritable: false },
      { pubkey: quoteMint, isSigner: false, isWritable: false },
      { pubkey: userBaseAta, isSigner: false, isWritable: true },
      { pubkey: userQuoteAta, isSigner: false, isWritable: true },
      { pubkey: poolBaseVault, isSigner: false, isWritable: true },
      { pubkey: poolQuoteVault, isSigner: false, isWritable: true },
      { pubkey: PROTOCOL_FEE_RECIPIENT, isSigner: false, isWritable: false },
      { pubkey: protocolFeeRecipientAta, isSigner: false, isWritable: true },
      { pubkey: baseTokenProgram, isSigner: false, isWritable: false },
      { pubkey: quoteTokenProgram, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMP_SWAP_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: creatorVaultAta, isSigner: false, isWritable: true },
      { pubkey: creatorVaultAuthority, isSigner: false, isWritable: false },
      ...extraKeys,
    ];
  }

  // PumpSwap Buy/Sell is relative to the BASE token of the pool:
  //   Buy  = spend quote, receive base  (data: base_amount_out, max_quote_amount_in)
  //   Sell = spend base, receive quote  (data: base_amount_in, min_quote_amount_out)
  //
  // Our intent is always "buy token with SOL" or "sell token for SOL".
  // When solSide='quote' (base=token, quote=SOL): our buy → PumpSwap Buy, our sell → PumpSwap Sell
  // When solSide='base'  (base=SOL, quote=token): our buy → PumpSwap Sell, our sell → PumpSwap Buy
  const useProgramBuy = (isBuy && solSide === 'quote') || (!isBuy && solSide === 'base');

  if (isBuy) {
    // ── BUY: spend SOL, receive token ─────────────────────────────────────
    const solPriceUsd = await getSolPriceUsd();
    const solLamports = BigInt(Math.floor((order.position_size_usd / solPriceUsd) * LAMPORTS_PER_SOL));
    if (solLamports <= 0n) throw new Error('SOLANA_SWAP_BUY_AMOUNT_TOO_SMALL');

    const slipBps = BigInt(slippageBps);

    // Estimate tokenOut for min_base_amount_out (slippage safety floor).
    // effectiveQuote = solLamports * 10000 / (10000 + totalFeeBps)
    // tokenOut = tokenReserve * effectiveQuote / (solReserve + effectiveQuote)
    const tokenReserve = solSide === 'quote' ? baseReserve : quoteReserve;
    const solReserve = solSide === 'quote' ? quoteReserve : baseReserve;

    const effectiveQuote = solLamports * 10000n / (10000n + ESTIMATED_TOTAL_FEE_BPS);
    const tokenOut = tokenReserve * effectiveQuote / (solReserve + effectiveQuote);
    if (tokenOut <= 0n) throw new Error('SOLANA_SWAP_BUY_ZERO_OUTPUT');

    // Slippage-adjusted minimum output
    const minTokenOut = tokenOut * (10000n - slipBps) / 10000n;

    // SOL with slippage for WSOL funding (safety margin)
    let maxSolIn = solLamports * (10000n + slipBps) / 10000n;
    if (solLamports * (10000n + slipBps) % 10000n !== 0n) maxSolIn += 1n;

    // 1) Create + fund WSOL ATA
    const solAcctInfo = await connection.getAccountInfo(userSolAta);
    if (!solAcctInfo) {
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(user, userSolAta, user, WSOL_PK, TOKEN_PROGRAM_ID),
      );
    }
    instructions.push(
      SystemProgram.transfer({ fromPubkey: user, toPubkey: userSolAta, lamports: Number(maxSolIn) }),
      createSyncNativeInstruction(userSolAta, TOKEN_PROGRAM_ID),
    );

    // 2) Create token ATA if needed
    const tokenAcctInfo = await connection.getAccountInfo(userTokenAta);
    if (!tokenAcctInfo) {
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(user, userTokenAta, user, tokenMint, nonSolTokenProgram),
      );
    }

    // 3) Swap instruction
    if (useProgramBuy) {
      // base=token, quote=SOL → Buy: specify token amount out and max SOL to spend.
      const data = Buffer.alloc(25);
      BUY_DISCRIMINATOR.copy(data, 0);
      data.writeBigUInt64LE(tokenOut, 8);           // base_amount_out
      data.writeBigUInt64LE(maxSolIn, 16);          // max_quote_amount_in
      data.writeUInt8(1, 24);                       // track_volume = OptionBool(true)

      instructions.push(
        new TransactionInstruction({
          programId: PUMP_SWAP_PROGRAM_ID,
          keys: swapKeys([...buyExtraKeys, ...buyRemainingAccounts]),
          data,
        }),
      );
    } else {
      // base=SOL, quote=token → PumpSwap Sell: spend base (SOL), receive quote (token)
      const data = Buffer.alloc(24);
      SELL_DISCRIMINATOR.copy(data, 0);
      data.writeBigUInt64LE(solLamports, 8);     // base_amount_in
      data.writeBigUInt64LE(minTokenOut, 16);    // min_quote_amount_out

      instructions.push(
        new TransactionInstruction({
          programId: PUMP_SWAP_PROGRAM_ID,
          keys: swapKeys([...sellExtraKeys, ...sellRemainingAccounts]),
          data,
        }),
      );
    }
  } else {
    // ── SELL: spend token, receive SOL ────────────────────────────────────
    const tokenAcctInfo = await connection.getAccountInfo(userTokenAta);
    if (!tokenAcctInfo) {
      throw new Error('SOLANA_SWAP_SELL_INSUFFICIENT_TOKEN_BALANCE');
    }
    const balanceRaw = tokenAcctInfo.data.readBigUInt64LE(64);
    if (balanceRaw <= 0n) {
      throw new Error('SOLANA_SWAP_SELL_INSUFFICIENT_TOKEN_BALANCE');
    }

    // SDK sellBaseInput formula (no manual fee deduction — program handles fees):
    // grossQuoteOut = quoteReserve * base / (baseReserve + base)
    // For our sell: base_in is the token, quote_out is SOL.
    const tokenReserve = solSide === 'quote' ? baseReserve : quoteReserve;
    const solReserve = solSide === 'quote' ? quoteReserve : baseReserve;

    let grossSolOut = solReserve * balanceRaw / (tokenReserve + balanceRaw);

    // Account for fees the program will deduct from the output
    const netSolOut = grossSolOut * (10000n - ESTIMATED_TOTAL_FEE_BPS) / 10000n;

    const slipBps = BigInt(slippageBps);
    const minSolOut = netSolOut * (10000n - slipBps) / 10000n;

    const isDustSell = order.reason?.toLowerCase().includes('dust') === true;

    // Ensure WSOL ATA exists to receive SOL proceeds
    const solAcctInfo = await connection.getAccountInfo(userSolAta);
    if (!solAcctInfo) {
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(user, userSolAta, user, WSOL_PK, TOKEN_PROGRAM_ID),
      );
    }

    if (useProgramBuy) {
      // base=SOL, quote=token → Buy: spend SOL (base_amount_out), receive token (quote).
      // Inverted pool: our "sell token" means PumpSwap Buy (SOL=base, token=quote).
      // base_amount_out is a minimum floor — use fee+slippage adjusted value, not gross.
      const maxTokenIn = balanceRaw;
      const data = Buffer.alloc(25);
      BUY_DISCRIMINATOR.copy(data, 0);
      data.writeBigUInt64LE(minSolOut, 8);          // base_amount_out (min SOL to receive)
      data.writeBigUInt64LE(maxTokenIn, 16);        // max_quote_amount_in
      data.writeUInt8(1, 24);                       // track_volume = OptionBool(true)

      instructions.push(
        new TransactionInstruction({
          programId: PUMP_SWAP_PROGRAM_ID,
          keys: swapKeys([...buyExtraKeys, ...buyRemainingAccounts]),
          data,
        }),
      );
    } else {
      // base=token, quote=SOL → PumpSwap Sell: spend base (token), receive quote (SOL)
      const data = Buffer.alloc(24);
      SELL_DISCRIMINATOR.copy(data, 0);
      data.writeBigUInt64LE(balanceRaw, 8);      // base_amount_in
      data.writeBigUInt64LE(minSolOut, 16);      // min_quote_amount_out

      instructions.push(
        new TransactionInstruction({
          programId: PUMP_SWAP_PROGRAM_ID,
          keys: swapKeys([...sellExtraKeys, ...sellRemainingAccounts]),
          data,
        }),
      );
    }

    // Sync and close WSOL ATA to unwrap proceeds back to native SOL
    instructions.push(
      createSyncNativeInstruction(userSolAta, TOKEN_PROGRAM_ID),
      createCloseAccountInstruction(userSolAta, user, user),
    );
  }

  return new Transaction().add(...instructions);
}
