// src/common/cycle-profit-calculator.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { FeeCalculatorService } from './fee-calculator.service';
import { ExchangeService } from './exchange.service';

@Injectable()
export class CycleProfitCalculatorService {
  private readonly logger = new Logger(CycleProfitCalculatorService.name);
  public readonly TARGET_CYCLE_PROFIT_PERCENT = 0.4; // 전체 사이클 목표 수익률 1% (여기서는 0.6으로 설정되어 있음)

  constructor(
    private readonly feeCalculatorService: FeeCalculatorService,
    private readonly exchangeService: ExchangeService,
  ) {}

  async calculateOverallCycleProfit(
    symbolHigh: string,
    upbitPriceHigh: number,
    binancePriceHigh: number,
    initialInvestmentUSDT: number, // 첫 고프리미엄 매수 투자 금액 (USDT)
    allWatchedSymbols: { symbol: string; upbit: string; binance: string }[],
    upbitPrices: Map<string, number>,
    binancePrices: Map<string, number>,
  ): Promise<{
    isProfitable: boolean;
    netProfitHighPremiumKRW: number;
    netProfitLowPremiumKRW: number;
    totalNetProfitKRW: number;
    totalNetProfitPercent: number;
    recommendedLowPremiumSymbol?: string;
    totalNetProfitUsd: number; // <-- 반환 타입에 추가
  }> {
    const rate = await this.exchangeService.getUSDTtoKRW();
    const initialInvestmentKRW = initialInvestmentUSDT * rate;

    const highPremiumBuyAmount =
      binancePriceHigh !== 0 ? initialInvestmentUSDT / binancePriceHigh : 0; // 0으로 나누기 방지
    const highPremiumResult = this.feeCalculatorService.calculate({
      symbol: symbolHigh,
      amount: highPremiumBuyAmount,
      upbitPrice: upbitPriceHigh,
      binancePrice: binancePriceHigh,
      rate: rate,
      tradeDirection: 'HIGH_PREMIUM_SELL_UPBIT',
    });
    const netProfitHighPremiumKRW = highPremiumResult.netProfit;

    let maxLowPremiumNetProfitKRW = -Infinity;
    let recommendedLowPremiumSymbol: string | undefined;

    for (const { symbol: symbolLow } of allWatchedSymbols) {
      const upbitPriceLow = upbitPrices.get(symbolLow);
      const binancePriceLow = binancePrices.get(symbolLow);

      if (!upbitPriceLow || !binancePriceLow) continue;

      const estimatedAvailableKRWForLowPremium =
        initialInvestmentKRW + netProfitHighPremiumKRW;

      const lowPremiumBuyAmountKRW = estimatedAvailableKRWForLowPremium / 2; // 가용 자금의 절반을 저프리미엄 매수에 사용 (예시)
      const lowPremiumBuyAmount =
        upbitPriceLow !== 0 ? lowPremiumBuyAmountKRW / upbitPriceLow : 0; // 0으로 나누기 방지

      const lowPremiumResult = this.feeCalculatorService.calculate({
        symbol: symbolLow,
        amount: lowPremiumBuyAmount,
        upbitPrice: upbitPriceLow,
        binancePrice: binancePriceLow,
        rate: rate,
        tradeDirection: 'LOW_PREMIUM_SELL_BINANCE',
      });

      if (lowPremiumResult.netProfit > maxLowPremiumNetProfitKRW) {
        maxLowPremiumNetProfitKRW = lowPremiumResult.netProfit;
        recommendedLowPremiumSymbol = symbolLow;
      }
    }

    const netProfitLowPremiumKRW = maxLowPremiumNetProfitKRW;

    const totalNetProfitKRW = netProfitHighPremiumKRW + netProfitLowPremiumKRW;
    const totalNetProfitPercent =
      (totalNetProfitKRW / initialInvestmentKRW) * 100;

    const totalNetProfitUsd = totalNetProfitKRW / rate; // KRW 수익을 USD로 환산

    const isProfitable =
      totalNetProfitPercent >= this.TARGET_CYCLE_PROFIT_PERCENT;

    this.logger.log(
      `[CYCLE PROFIT] ${symbolHigh.toUpperCase()} 고프리미엄 & ${recommendedLowPremiumSymbol?.toUpperCase() || 'N/A'} 저프리미엄 예상`,
    );
    this.logger.log(
      ` - 고프리미엄 순이익: ${netProfitHighPremiumKRW.toFixed(0)}₩`,
    );
    this.logger.log(
      ` - 저프리미엄 예상 순이익: ${netProfitLowPremiumKRW.toFixed(0)}₩`,
    );
    this.logger.log(
      ` - 총 예상 순이익: ${totalNetProfitKRW.toFixed(0)}₩ (${totalNetProfitPercent.toFixed(2)}%)`,
    );

    return {
      isProfitable,
      netProfitHighPremiumKRW,
      netProfitLowPremiumKRW,
      totalNetProfitKRW,
      totalNetProfitPercent,
      recommendedLowPremiumSymbol,
      totalNetProfitUsd, // <-- 반환 값에 추가
    };
  }
}
