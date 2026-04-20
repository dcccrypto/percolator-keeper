import { Connection, SystemProgram } from "@solana/web3.js";
import { sendKeeperTxViaSender, loadKeypair } from "@percolatorct/shared";
import fs from "node:fs";

async function main() {
  const url = process.env.SOLANA_RPC_URL;
  const kpPath = process.env.KEEPER_KEYPAIR_PATH;
  if (!url) throw new Error("SOLANA_RPC_URL not set");
  if (!kpPath) throw new Error("KEEPER_KEYPAIR_PATH not set");

  const conn = new Connection(url, "confirmed");
  const kp = loadKeypair(fs.readFileSync(kpPath, "utf8"));
  const ix = SystemProgram.transfer({
    fromPubkey: kp.publicKey,
    toPubkey: kp.publicKey,
    lamports: 1,
  });

  const t0 = Date.now();
  const sig = await sendKeeperTxViaSender(conn, [ix], [kp], {
    priorityLevel: "High",
    tipLamports: 200_000,
  });
  const elapsed = Date.now() - t0;

  console.log(`sig=${sig}`);
  console.log(`elapsed_ms=${elapsed}`);
  console.log(`https://orbmarkets.io/tx/${sig}`);

  if (elapsed > 5000) {
    console.warn(`WARN: elapsed ${elapsed}ms > 5000ms — tip or RPC may be misconfigured`);
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
