import { appConfig } from "../config.js";
import { HyperliquidTradingService } from "../services/hyperliquidTradingService.js";
import { buildFailure, buildSuccess } from "../utils/formatting.js";
import { createRequestId, logEvent } from "../utils/logging.js";
import { withdrawFromHyperliquidInputSchema } from "../utils/validation.js";
import type { ToolResponse } from "../types.js";

export async function withdrawFromHyperliquidTool(
  input: unknown,
  hyperliquidTradingService: HyperliquidTradingService
): Promise<ToolResponse<Record<string, unknown>>> {
  const requestId = createRequestId();
  const parsed = withdrawFromHyperliquidInputSchema.parse(input);
  const quote = await hyperliquidTradingService.quoteWithdraw(parsed);

  if (!parsed.approval) {
    logEvent(requestId, "withdraw_from_hyperliquid", "rejected", {
      destination: parsed.destination,
      amount: quote.requestedAmount
    });
    return buildFailure("withdraw_from_hyperliquid", requestId, "rejected", [
      "withdraw_from_hyperliquid requires approval=true."
    ], {
      quote
    });
  }

  const dryRun = parsed.dryRun ?? appConfig.safety.dryRunDefault;
  if (dryRun) {
    logEvent(requestId, "withdraw_from_hyperliquid", "dry_run", {
      destination: parsed.destination,
      amount: quote.requestedAmount
    });
    return buildSuccess("withdraw_from_hyperliquid", requestId, "dry_run", {
      quote
    });
  }

  const execution = await hyperliquidTradingService.withdraw(parsed);
  logEvent(requestId, "withdraw_from_hyperliquid", "submitted", {
    destination: parsed.destination,
    amount: quote.requestedAmount
  });

  return buildSuccess("withdraw_from_hyperliquid", requestId, "submitted", {
    quote,
    execution
  });
}
