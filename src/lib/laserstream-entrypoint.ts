import type { Connection } from "@solana/web3.js";
import { AccountLoader, type AccountLoaderOptions } from "./account-loader.js";

type Logger = {
  warn(message: string, meta?: Record<string, unknown>): void;
};

type WarningAlert = (
  title: string,
  fields: Array<{ name: string; value: string; inline?: boolean }>,
) => Promise<unknown>;

type AccountLoaderCtor = new (opts: AccountLoaderOptions) => AccountLoader;

export interface CreateLaserStreamAccountLoaderParams {
  env?: NodeJS.ProcessEnv;
  programId: string;
  getConnection: () => Connection;
  logger?: Logger;
  sendWarningAlert?: WarningAlert;
  Loader?: AccountLoaderCtor;
}

export function laserStreamEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KEEPER_USE_LASERSTREAM === "true";
}

export function parseLaserStreamAdditionalAccounts(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export function createLaserStreamAccountLoader(
  params: CreateLaserStreamAccountLoaderParams,
): AccountLoader | null {
  const env = params.env ?? process.env;
  if (!laserStreamEnabled(env)) return null;

  const apiKey = env.HELIUS_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("KEEPER_USE_LASERSTREAM=true requires HELIUS_API_KEY");
  }

  const endpoint = env.HELIUS_LASERSTREAM_ENDPOINT?.trim();
  if (!endpoint) {
    throw new Error("KEEPER_USE_LASERSTREAM=true requires HELIUS_LASERSTREAM_ENDPOINT");
  }

  const programId = params.programId.trim();
  if (!programId) {
    throw new Error("KEEPER_USE_LASERSTREAM=true requires a configured programId");
  }

  const connection = params.getConnection();
  const additionalAccounts = parseLaserStreamAdditionalAccounts(
    env.KEEPER_LASERSTREAM_ADDITIONAL_ACCOUNTS ?? env.KEEPER_LASERSTREAM_ACCOUNTS,
  );

  const Loader = params.Loader ?? AccountLoader;
  return new Loader({
    apiKey,
    endpoint,
    programId,
    additionalAccounts,
    connection,
    getRpcSlot: () => connection.getSlot("confirmed"),
    onDriftAlert: (drift) => {
      params.logger?.warn("LaserStream slot drift exceeds threshold", { drift });
      void params.sendWarningAlert?.("LaserStream stream lagging RPC", [
        { name: "Slot Drift", value: drift.toString(), inline: true },
        { name: "Program", value: programId, inline: false },
      ]).catch(() => {});
    },
  });
}
