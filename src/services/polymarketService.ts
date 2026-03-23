import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { getAddress, type Address, type Hash } from "viem";
import { getChainConfig, getConfiguredStablecoins } from "../chains/index.js";
import { appConfig } from "../config.js";
import type {
  ChainName,
  PolymarketDepositAddresses,
  PolymarketDepositQuote,
  PolymarketSupportedAsset,
  TokenInfo
} from "../types.js";
import { formatTokenAmount } from "../utils/formatting.js";
import { TokenService } from "./tokenService.js";
import { WalletService } from "./walletService.js";

interface SupportedAssetsResponse {
  supportedAssets: Array<{
    chainId: string;
    chainName: string;
    token: {
      name: string;
      symbol: string;
      address: string;
      decimals: number;
    };
    minCheckoutUsd: number;
  }>;
}

interface DepositAddressesResponse {
  address: {
    evm: string;
    svm?: string;
    tron?: string;
    btc?: string;
  };
  note?: string;
}

interface QuoteResponse {
  estCheckoutTimeMs?: number;
  estFeeBreakdown?: Record<string, unknown> & {
    minReceived?: number;
    totalImpact?: number;
  };
  estInputUsd?: number;
  estOutputUsd?: number;
  estToTokenBaseUnit?: string;
  quoteId?: string;
}

interface StatusResponse {
  transactions: Array<Record<string, unknown>>;
}

const execFile = promisify(execFileCallback);

export class PolymarketService {
  public constructor(
    private readonly walletService: WalletService,
    private readonly tokenService: TokenService
  ) {}

  public async getSupportedAssets(): Promise<PolymarketSupportedAsset[]> {
    const response = await this.fetchJson<SupportedAssetsResponse>("/supported-assets", {
      method: "GET"
    });

    return response.supportedAssets.map((asset) => ({
      chainId: asset.chainId,
      chainName: asset.chainName,
      token: {
        name: asset.token.name,
        symbol: asset.token.symbol,
        address: asset.token.address,
        decimals: asset.token.decimals
      },
      minCheckoutUsd: asset.minCheckoutUsd
    }));
  }

  public async createDepositAddresses(destinationWallet: Address): Promise<PolymarketDepositAddresses> {
    const response = await this.fetchJson<DepositAddressesResponse>("/deposit", {
      method: "POST",
      body: JSON.stringify({
        address: destinationWallet
      })
    });

    return {
      evm: getAddress(response.address.evm),
      svm: response.address.svm,
      tron: response.address.tron,
      btc: response.address.btc
    };
  }

  public async getDepositStatus(depositAddress: Address): Promise<StatusResponse> {
    return this.fetchJson<StatusResponse>(`/status/${depositAddress}`, {
      method: "GET"
    });
  }

  public async quoteDeposit(input: {
    sourceChain: ChainName;
    token: string;
    amount: string;
    destination: Address;
  }): Promise<PolymarketDepositQuote> {
    const sourceToken = await this.tokenService.resolveToken(input.sourceChain, input.token);
    if (sourceToken.isNative) {
      throw new Error("deposit_to_polymarket currently supports ERC-20 tokens only.");
    }

    const supportedAsset = await this.findSupportedAsset(input.sourceChain, sourceToken);
    if (!supportedAsset) {
      throw new Error(`Polymarket does not currently support ${sourceToken.symbol} deposits from ${input.sourceChain}.`);
    }

    const depositAddresses = await this.createDepositAddresses(input.destination);
    const polygonUsdcE = getConfiguredStablecoins("polygon").find((token) => token.symbol === "USDC.E");
    if (!polygonUsdcE?.address) {
      throw new Error("Polygon USDC.e configuration is missing.");
    }

    const amountRaw = this.tokenService.amountToRaw(input.amount, sourceToken);
    const quoteResponse = await this.fetchJson<QuoteResponse>("/quote", {
      method: "POST",
      body: JSON.stringify({
        fromAmountBaseUnit: amountRaw.toString(),
        fromChainId: supportedAsset.chainId,
        fromTokenAddress: supportedAsset.token.address,
        recipientAddress: depositAddresses.evm,
        toChainId: String(getChainConfig("polygon").chainId),
        toTokenAddress: polygonUsdcE.address
      })
    });

    const estimatedInputUsd = quoteResponse.estInputUsd;
    if (
      typeof estimatedInputUsd === "number" &&
      Number.isFinite(estimatedInputUsd) &&
      estimatedInputUsd < supportedAsset.minCheckoutUsd
    ) {
      throw new Error(
        `Requested deposit is below Polymarket minimum for ${sourceToken.symbol} on ${input.sourceChain}. Estimated input USD ${estimatedInputUsd} is below minimum ${supportedAsset.minCheckoutUsd}.`
      );
    }

    return {
      sourceChain: input.sourceChain,
      sourceToken,
      amount: input.amount,
      depositAddresses,
      depositAddress: depositAddresses.evm,
      destinationWallet: input.destination,
      supportedAsset,
      quoteId: quoteResponse.quoteId,
      estimatedCheckoutTimeMs: quoteResponse.estCheckoutTimeMs,
      estimatedInputUsd:
        typeof quoteResponse.estInputUsd === "number" ? quoteResponse.estInputUsd.toFixed(6) : undefined,
      estimatedOutputUsd:
        typeof quoteResponse.estOutputUsd === "number" ? quoteResponse.estOutputUsd.toFixed(6) : undefined,
      estimatedReceivedUsdcE: quoteResponse.estToTokenBaseUnit
        ? formatTokenAmount(BigInt(quoteResponse.estToTokenBaseUnit), polygonUsdcE.decimals)
        : "0",
      minimumReceivedUsdcE:
        typeof quoteResponse.estFeeBreakdown?.minReceived === "number"
          ? quoteResponse.estFeeBreakdown.minReceived.toFixed(6)
          : undefined,
      feeBreakdown: quoteResponse.estFeeBreakdown,
      statusEndpoint: `${appConfig.polymarket.apiUrl}/status/${depositAddresses.evm}`,
      raw: quoteResponse as Record<string, unknown>
    };
  }

  public async executeDeposit(input: {
    sourceChain: ChainName;
    token: string;
    amount: string;
    destination: Address;
    }): Promise<{
      sourceTxHash: Hash;
      depositAddress: Address;
      destinationWallet: Address;
      quote: PolymarketDepositQuote;
      initialStatus: {
        transactions: Array<Record<string, unknown>>;
      };
    }> {
    const quote = await this.quoteDeposit(input);
    const amountRaw = this.tokenService.amountToRaw(input.amount, quote.sourceToken);
    const sourceTxHash = await this.tokenService.transferToken(
      input.sourceChain,
      quote.depositAddress,
      quote.sourceToken,
      amountRaw
    );
    await this.walletService.waitForReceipt(input.sourceChain, sourceTxHash);

    // Polymarket status is asynchronous; return the first observed status snapshot immediately after funding.
    const initialStatus = await this.getDepositStatus(quote.depositAddress);

    return {
      sourceTxHash,
      depositAddress: quote.depositAddress,
      destinationWallet: quote.destinationWallet,
      quote,
      initialStatus
    };
  }

  public getEstimatedFeeBps(quote: PolymarketDepositQuote): number | undefined {
    const totalImpact = quote.feeBreakdown?.totalImpact;
    if (typeof totalImpact !== "number" || !Number.isFinite(totalImpact)) {
      return undefined;
    }

    return Math.ceil(totalImpact * 100);
  }

  private async findSupportedAsset(chain: ChainName, token: TokenInfo): Promise<PolymarketSupportedAsset | undefined> {
    const chainId = String(getChainConfig(chain).chainId);
    const supportedAssets = await this.getSupportedAssets();
    return supportedAssets.find((asset) => {
      return asset.chainId === chainId && asset.token.address.toLowerCase() === token.address?.toLowerCase();
    });
  }

  private async fetchJson<T>(pathname: string, init: RequestInit): Promise<T> {
    const url = `${appConfig.polymarket.apiUrl}${pathname}`;
    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(init.headers ?? {})
        },
        signal: AbortSignal.timeout(12_000)
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Polymarket API request failed (${response.status} ${response.statusText}): ${body}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!this.shouldRetryWithCurl(message)) {
        throw error;
      }
    }

    const args = ["-sS", "--connect-timeout", "10", "--max-time", "20", "-X", init.method ?? "GET"];
    const headers = init.headers ?? {};
    for (const [key, value] of Object.entries(headers)) {
      args.push("-H", `${key}: ${value}`);
    }
    args.push(url);

    if (typeof init.body === "string" && init.body.length > 0) {
      args.push("--data", init.body);
    }

    const { stdout, stderr } = await execFile("curl", args);
    if (stderr.trim()) {
      throw new Error(`Polymarket API request failed via curl: ${stderr.trim()}`);
    }

    return JSON.parse(stdout) as T;
  }

  private shouldRetryWithCurl(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
      normalized.includes("fetch failed") ||
      normalized.includes("timed out") ||
      normalized.includes("timeout") ||
      normalized.includes("connect")
    );
  }
}
