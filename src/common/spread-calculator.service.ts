// src/common/spread-calculator.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ExchangeService } from './exchange.service';
import { FeeCalculatorService } from './fee-calculator.service';
import { HighPremiumConditionData } from '../arbitrage/high-premium-processor.service'; // 타입 import

@Injectable()
export class SpreadCalculatorService {
  private readonly logger = new Logger(SpreadCalculatorService.name);

  constructor(
    private readonly exchangeService: ExchangeService,
    private readonly feeCalculatorService: FeeCalculatorService,
  ) {}

  // [수정] 콜백 대신 HighPremiumConditionData 또는 null을 반환하도록 변경
  async calculateSpread(params: {
    symbol: string;
    upbitPrice: number;
    binancePrice: number;
    profitThresholdPercent: number;
  }): Promise<HighPremiumConditionData | null> {
    const { symbol, upbitPrice, binancePrice, profitThresholdPercent } = params;

    if (upbitPrice === undefined || binancePrice === undefined) {
      return null;
    }

    const rate = this.exchangeService.getUSDTtoKRW();
    const globalPrice = binancePrice * rate;
    const spread = ((upbitPrice - globalPrice) / globalPrice) * 100;

    // 간단한 투자금 예시로 순수익률 계산
    const investmentUSDTForCalc = 1000;
    const buyAmount =
      binancePrice !== 0 ? investmentUSDTForCalc / binancePrice : 0;
    if (buyAmount <= 0) return null;

    const result = this.feeCalculatorService.calculate({
      symbol,
      amount: buyAmount,
      upbitPrice,
      binancePrice,
      rate,
      tradeDirection: 'HIGH_PREMIUM_SELL_UPBIT',
    });

    if (result.netProfitPercent > profitThresholdPercent) {
      this.logger.log(
        `[OPPORTUNITY FOUND] ${symbol.toUpperCase()}: Net profit ${result.netProfitPercent.toFixed(2)}%`,
      );
      // [수정] 콜백 호출 대신 데이터 객체를 반환
      return {
        symbol,
        upbitPrice,
        binancePrice,
        rate,
        netProfit: result.netProfit,
        netProfitPercent: result.netProfitPercent,
      };
    }

    return null; // 조건 미충족 시 null 반환
  }
}
