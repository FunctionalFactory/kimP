// src/common/cycle-profit-calculator.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { FeeCalculatorService } from './fee-calculator.service';
import { ExchangeService } from './exchange.service';

@Injectable()
export class CycleProfitCalculatorService {
  private readonly logger = new Logger(CycleProfitCalculatorService.name);
  public readonly TARGET_CYCLE_PROFIT_PERCENT = 0.01; // 전체 사이클 목표 수익률 1% (여기서는 0.6으로 설정되어 있음)

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
    let bestLowPremiumResult: any = null; // 가장 수익성이 좋았던 저프리미엄 거래 결과 저장용

    for (const { symbol: symbolLow } of allWatchedSymbols) {
      const upbitPriceLow = upbitPrices.get(symbolLow);
      const binancePriceLow = binancePrices.get(symbolLow);

      if (!upbitPriceLow || !binancePriceLow) {
        continue;
      }

      // WsService에서는 저프리미엄 투자금을 초기 자본의 절반으로 설정하고 있습니다.
      // 이 계산기에서는 어떤 기준으로 저프리미엄 투자금을 설정하는지 확인 필요.
      // 여기서는 전체 가용 자금의 절반을 사용한다고 가정합니다.
      // 실제 WsService의 로직과 일치시키려면 WsService에서 사용하는 저프리미엄 투자금액을 기준으로 계산해야 합니다.
      // 현재 WsService는 totalKRWCapital / 2 (즉, 10,000,000 KRW)을 저프리미엄 투자금으로 사용합니다.
      // 이 부분은 WsService에서 handleLowPremiumFlow 호출 시 전달하는 investmentKRW와 일치하도록
      // 또는 유사한 로직으로 계산되어야 합니다.
      // 여기서는 WsService와 동일하게 초기 투자금의 절반을 사용한다고 가정합니다.
      // const lowPremiumBuyAmountKRW = estimatedAvailableKRWForLowPremium / 2; // 가용 자금의 절반을 저프리미엄 매수에 사용 (예시)
      const lowPremiumInvestmentKRW = initialInvestmentKRW; // 고프리미엄과 동일한 초기 투자금액(의 절반)을 사용한다고 가정

      // const lowPremiumBuyAmount =
      //   upbitPriceLow !== 0 ? lowPremiumBuyAmountKRW / upbitPriceLow : 0; // 0으로 나누기 방지
      const lowPremiumBuyAmount =
        upbitPriceLow !== 0 ? lowPremiumInvestmentKRW / upbitPriceLow : 0;

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

    const netProfitLowPremiumKRW =
      maxLowPremiumNetProfitKRW === -Infinity ? 0 : maxLowPremiumNetProfitKRW; // 저프리미엄 기회가 없으면 0으로

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
