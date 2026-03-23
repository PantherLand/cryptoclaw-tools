import { appConfig } from "../config.js";
import { PolymarketService } from "../services/polymarketService.js";
import { RiskService } from "../services/riskService.js";
import { WalletService } from "../services/walletService.js";
import { buildFailure, buildSuccess } from "../utils/formatting.js";
import { createRequestId, logEvent } from "../utils/logging.js";
import { depositToPolymarketInputSchema } from "../utils/validation.js";
import type { ToolResponse } from "../types.js";

function isAllowlistedDestination(destination: string, treasuryAddress: string): boolean {
  const allowlist = new Set([
    ...appConfig.safety.allowlist.map((address) => address.toLowerCase()),
    treasuryAddress.toLowerCase()
  ]);

  return allowlist.has(destination.toLowerCase());
}

export async function depositToPolymarketTool(
  input: unknown,
  walletService: WalletService,
  polymarketService: PolymarketService,
  riskService: RiskService
): Promise<ToolResponse<Record<string, unknown>>> {
  const requestId = createRequestId();
  const parsed = depositToPolymarketInputSchema.parse(input);
  const treasuryAddress = walletService.getTreasuryAddress();

  if (appConfig.safety.strictAllowlist && !isAllowlistedDestination(parsed.destination, treasuryAddress)) {
    return buildFailure("deposit_to_polymarket", requestId, "rejected", [
      "Destination Polymarket wallet is not allowlisted."
    ]);
  }

  const quote = await polymarketService.quoteDeposit(parsed);
  const safety = await riskService.evaluate({
    operationType: "deposit_to_polymarket",
    chain: parsed.sourceChain,
    tokenSymbol: quote.sourceToken.symbol,
    amount: parsed.amount,
    destination: quote.depositAddress,
    feeBps: polymarketService.getEstimatedFeeBps(quote),
    approval: parsed.approval,
    requireDestinationAllowlist: false,
    requireGasReserve: true
  });

  const combinedWarnings = [...safety.warnings];
  if (quote.depositAddress.toLowerCase() !== parsed.destination.toLowerCase()) {
    combinedWarnings.push(
      "Transfer recipient is a Polymarket-generated deposit address. The final credited wallet remains the requested destination."
    );
  }

  if (!safety.approved) {
    logEvent(requestId, "deposit_to_polymarket", "rejected", {
      sourceChain: parsed.sourceChain,
      tokenSymbol: quote.sourceToken.symbol,
      amount: parsed.amount,
      destination: parsed.destination
    });
    return buildFailure("deposit_to_polymarket", requestId, "rejected", safety.reasons, {
      quote,
      safety
    }, combinedWarnings);
  }

  const dryRun = parsed.dryRun ?? appConfig.safety.dryRunDefault;
  if (dryRun) {
    logEvent(requestId, "deposit_to_polymarket", "dry_run", {
      sourceChain: parsed.sourceChain,
      tokenSymbol: quote.sourceToken.symbol,
      amount: parsed.amount,
      destination: parsed.destination
    });
    return buildSuccess("deposit_to_polymarket", requestId, "dry_run", {
      treasuryAddress,
      quote,
      safety
    }, combinedWarnings);
  }

  const execution = await polymarketService.executeDeposit(parsed);
  logEvent(requestId, "deposit_to_polymarket", "submitted", {
    sourceChain: parsed.sourceChain,
    tokenSymbol: execution.quote.sourceToken.symbol,
    amount: parsed.amount,
    destination: parsed.destination,
    depositAddress: execution.depositAddress,
    sourceTxHash: execution.sourceTxHash
  });

  return buildSuccess("deposit_to_polymarket", requestId, "submitted", {
    treasuryAddress,
    execution,
    safety
  }, combinedWarnings);
}
