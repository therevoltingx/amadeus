declare module 'pumpfun-pumpswap-sdk/src/buy.js' {
  import type { Connection, Keypair, PublicKey } from '@solana/web3.js';
  import type { TransactionInstruction } from '@solana/web3.js';
  export function buildPumpFunBuy(
    connection: Connection,
    mint: PublicKey,
    userKeypair: Keypair,
    lamportsAmount: bigint,
    slippage?: number
  ): Promise<{ instructions: TransactionInstruction[]; tokenAmount?: bigint; tokenPrice?: number }>;
}

declare module 'pumpfun-pumpswap-sdk/src/sell.js' {
  import type { Connection, PublicKey } from '@solana/web3.js';
  import type { TransactionInstruction } from '@solana/web3.js';
  export function buildPumpFunSell(
    connection: Connection,
    mint: PublicKey,
    userPubkey: PublicKey,
    tokenLamports: bigint,
    closeTokenAta?: boolean,
    slippage?: number
  ): Promise<{ instructions: TransactionInstruction[]; lamportsOut?: bigint }>;
}
