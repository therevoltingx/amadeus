/**
 * SOL/USD price from Chainlink Data Feeds on Solana via RPC (e.g. Helius).
 * Feed account layout matches chainlink_solana crate v2 (Transmissions + Transmission).
 * Set CHAINLINK_SOL_USD_FEED_ADDRESS to the SOL/USD feed account (see Chainlink Solana Feeds docs).
 */
import { Connection, PublicKey } from '@solana/web3.js';

/** Chainlink Data Feeds OCR2 program (feed account owner) on Solana mainnet/devnet. */
const CHAINLINK_FEED_PROGRAM_ID = new PublicKey('HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny');

const DISCRIMINATOR_LEN = 8;
const HEADER_SIZE = 192;
const TRANSMISSION_SIZE = 48;
/** Decimals byte in Transmissions header (after version, state, owner, proposed_owner, writer, description). */
const DECIMALS_OFFSET = 8 + 1 + 1 + 32 + 32 + 32 + 32;
/** Answer i128 in Transmission: after slot (8) + timestamp (4) + padding (4). */
const ANSWER_OFFSET = 8 + HEADER_SIZE + 8 + 4 + 4;
const ANSWER_LEN = 16;

function readI128LE(data: Buffer, offset: number): number {
  const buf = data.subarray(offset, offset + ANSWER_LEN);
  const lo = buf.readBigUInt64LE(0);
  const hi = buf.readBigUInt64LE(8);
  const combined = (hi << 64n) | lo;
  const isNeg = (buf[15] & 0x80) !== 0;
  if (isNeg) {
    const mask = (1n << 128n) - 1n;
    const signed = BigInt.asIntN(128, combined);
    return Number(signed);
  }
  return Number(combined);
}

/**
 * Fetch SOL/USD price from a Chainlink feed account via RPC.
 * Requires connection (e.g. Helius) and the feed account address for SOL/USD.
 * Returns the latest answer as USD price, or null if fetch/parse fails.
 */
export async function getSolPriceUsdFromChainlink(
  connection: Connection,
  feedAddress: string
): Promise<number | null> {
  try {
    const pubkey = new PublicKey(feedAddress);
    const account = await connection.getAccountInfo(pubkey, { commitment: 'confirmed' });
    if (!account?.data || account.data.length < ANSWER_OFFSET + ANSWER_LEN) return null;
    if (!account.owner.equals(CHAINLINK_FEED_PROGRAM_ID)) return null;

    const data = Buffer.from(account.data);
    const decimals = data.readUInt8(DECIMALS_OFFSET);
    const answer = readI128LE(data, ANSWER_OFFSET);
    if (!Number.isFinite(answer) || answer <= 0 || decimals > 30) return null;

    const price = answer / 10 ** decimals;
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}
