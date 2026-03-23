import {
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  getMint,
} from "@solana/spl-token";
import { isSolMint } from "./jupiter-tokens.js";
import { waitForSignatureConfirmation } from "./solana-rpc.js";

/** Parse UI decimal string to raw token amount (bigint). */
export function parseUiAmountToAtomic(ui, decimals) {
  const s = String(ui ?? "").trim();
  if (!s) return null;
  const t = s;
  if (!/^\d*\.?\d*$/.test(t) || t === ".") return null;
  const [wholeRaw, fracRaw = ""] = t.split(".");
  const whole = wholeRaw === "" ? "0" : wholeRaw;
  if (!/^\d+$/.test(whole)) return null;
  if (fracRaw && !/^\d+$/.test(fracRaw)) return null;
  const frac = (fracRaw + "0".repeat(decimals)).slice(0, decimals);
  const bi =
    BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac || "0");
  if (bi <= 0n) return null;
  return bi;
}

async function getMintProgramId(conn, mintPk) {
  const info = await conn.getAccountInfo(mintPk, "confirmed");
  if (!info) throw new Error("Mint account not found");
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

/**
 * Build + sign + send one SPL transfer (same mint each time).
 * Creates recipient ATA when missing (payer = sender).
 */
export async function sendSplAmountOnce(
  conn,
  provider,
  { owner, recipient, mintStr, amountAtomic }
) {
  const mintPk = new PublicKey(mintStr);
  const recipientPk = new PublicKey(recipient);
  const programId = await getMintProgramId(conn, mintPk);
  const mintInfo = await getMint(conn, mintPk, undefined, programId);
  const decimals = mintInfo.decimals;

  const sourceAta = getAssociatedTokenAddressSync(
    mintPk,
    owner,
    false,
    programId
  );
  const destAta = getAssociatedTokenAddressSync(
    mintPk,
    recipientPk,
    false,
    programId
  );

  const srcAcc = await getAccount(conn, sourceAta, undefined, programId);
  if (srcAcc.amount < amountAtomic) {
    throw new Error("Insufficient token balance");
  }

  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      destAta,
      recipientPk,
      mintPk,
      programId
    ),
    createTransferCheckedInstruction(
      sourceAta,
      mintPk,
      destAta,
      owner,
      amountAtomic,
      decimals,
      [],
      programId
    ),
  ];

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction().add(...ixs);
  tx.recentBlockhash = blockhash;
  tx.feePayer = owner;
  const signed = await provider.signTransaction(tx);
  const sig = await conn.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await waitForSignatureConfirmation(sig);
  return sig;
}

/**
 * One transaction: native SOL to many recipients (same lamports each).
 */
export async function sendNativeSolBatch(
  conn,
  provider,
  { from, recipientPubkeys, lamportsPerRecipient }
) {
  if (lamportsPerRecipient <= 0n) throw new Error("Amount must be positive");
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  if (lamportsPerRecipient > maxSafe) throw new Error("Amount too large");
  const lam = Number(lamportsPerRecipient);
  const ixs = recipientPubkeys.map((toPk) =>
    SystemProgram.transfer({
      fromPubkey: from,
      toPubkey: toPk,
      lamports: lam,
    })
  );
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction().add(...ixs);
  tx.recentBlockhash = blockhash;
  tx.feePayer = from;
  const signed = await provider.signTransaction(tx);
  const sig = await conn.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await waitForSignatureConfirmation(sig);
  return sig;
}

/**
 * One transaction: SPL / Token-2022 to many recipients (same amount each).
 */
export async function sendSplAmountBatch(
  conn,
  provider,
  { owner, mintStr, recipientPubkeys, amountAtomicPerRecipient }
) {
  const mintPk = new PublicKey(mintStr);
  const programId = await getMintProgramId(conn, mintPk);
  const mintInfo = await getMint(conn, mintPk, undefined, programId);
  const decimals = mintInfo.decimals;

  const sourceAta = getAssociatedTokenAddressSync(
    mintPk,
    owner,
    false,
    programId
  );
  const totalNeeded = amountAtomicPerRecipient * BigInt(recipientPubkeys.length);
  const srcAcc = await getAccount(conn, sourceAta, undefined, programId);
  if (srcAcc.amount < totalNeeded) {
    throw new Error("Insufficient token balance");
  }

  const ixs = [];
  for (const recipientPk of recipientPubkeys) {
    const destAta = getAssociatedTokenAddressSync(
      mintPk,
      recipientPk,
      false,
      programId
    );
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        destAta,
        recipientPk,
        mintPk,
        programId
      ),
      createTransferCheckedInstruction(
        sourceAta,
        mintPk,
        destAta,
        owner,
        amountAtomicPerRecipient,
        decimals,
        [],
        programId
      )
    );
  }

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction().add(...ixs);
  tx.recentBlockhash = blockhash;
  tx.feePayer = owner;
  const signed = await provider.signTransaction(tx);
  const sig = await conn.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await waitForSignatureConfirmation(sig);
  return sig;
}

/**
 * One transaction: native SOL to many recipients (custom amount each).
 */
export async function sendNativeSolBatchVariable(
  conn,
  provider,
  { from, recipientPubkeys, lamportsPerRecipient }
) {
  if (
    !Array.isArray(recipientPubkeys) ||
    !Array.isArray(lamportsPerRecipient) ||
    recipientPubkeys.length !== lamportsPerRecipient.length ||
    recipientPubkeys.length === 0
  ) {
    throw new Error("Recipients and amounts must match");
  }
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  const ixs = recipientPubkeys.map((toPk, i) => {
    const lamports = lamportsPerRecipient[i];
    if (lamports <= 0n) throw new Error("Amount must be positive");
    if (lamports > maxSafe) throw new Error("Amount too large");
    return SystemProgram.transfer({
      fromPubkey: from,
      toPubkey: toPk,
      lamports: Number(lamports),
    });
  });
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction().add(...ixs);
  tx.recentBlockhash = blockhash;
  tx.feePayer = from;
  const signed = await provider.signTransaction(tx);
  const sig = await conn.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await waitForSignatureConfirmation(sig);
  return sig;
}

/**
 * One transaction: SPL / Token-2022 to many recipients (custom amount each).
 */
export async function sendSplAmountBatchVariable(
  conn,
  provider,
  { owner, mintStr, recipientPubkeys, amountAtomicPerRecipient }
) {
  if (
    !Array.isArray(recipientPubkeys) ||
    !Array.isArray(amountAtomicPerRecipient) ||
    recipientPubkeys.length !== amountAtomicPerRecipient.length ||
    recipientPubkeys.length === 0
  ) {
    throw new Error("Recipients and amounts must match");
  }
  const mintPk = new PublicKey(mintStr);
  const programId = await getMintProgramId(conn, mintPk);
  const mintInfo = await getMint(conn, mintPk, undefined, programId);
  const decimals = mintInfo.decimals;

  const sourceAta = getAssociatedTokenAddressSync(
    mintPk,
    owner,
    false,
    programId
  );
  const totalNeeded = amountAtomicPerRecipient.reduce((sum, v) => sum + v, 0n);
  const srcAcc = await getAccount(conn, sourceAta, undefined, programId);
  if (srcAcc.amount < totalNeeded) {
    throw new Error("Insufficient token balance");
  }

  const ixs = [];
  for (let i = 0; i < recipientPubkeys.length; i += 1) {
    const recipientPk = recipientPubkeys[i];
    const amountAtomic = amountAtomicPerRecipient[i];
    if (amountAtomic <= 0n) throw new Error("Amount must be positive");
    const destAta = getAssociatedTokenAddressSync(
      mintPk,
      recipientPk,
      false,
      programId
    );
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        destAta,
        recipientPk,
        mintPk,
        programId
      ),
      createTransferCheckedInstruction(
        sourceAta,
        mintPk,
        destAta,
        owner,
        amountAtomic,
        decimals,
        [],
        programId
      )
    );
  }

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction().add(...ixs);
  tx.recentBlockhash = blockhash;
  tx.feePayer = owner;
  const signed = await provider.signTransaction(tx);
  const sig = await conn.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await waitForSignatureConfirmation(sig);
  return sig;
}

export async function sendNativeSolOnce(
  conn,
  provider,
  { from, to, lamports }
) {
  if (lamports <= 0n) throw new Error("Amount must be positive");
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  if (lamports > maxSafe) {
    throw new Error("Amount too large");
  }
  const lam = Number(lamports);
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from,
      toPubkey: new PublicKey(to),
      lamports: lam,
    })
  );
  tx.recentBlockhash = blockhash;
  tx.feePayer = from;
  const signed = await provider.signTransaction(tx);
  const sig = await conn.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await waitForSignatureConfirmation(sig);
  return sig;
}

export function uiSolToLamports(ui) {
  const a = parseUiAmountToAtomic(ui, 9);
  return a;
}

export { isSolMint, LAMPORTS_PER_SOL };
