import { Injectable, Logger } from '@nestjs/common';
import { ExchangeService } from './exchange.service';
import { FeeCalculatorService } from './fee-calculator.service';

@Injectable()
export class SpreadCalculatorService {
  private readonly logger = new Logger(SpreadCalculatorService.name);

  constructor(
    private readonly exchangeService: ExchangeService,
    private readonly feeCalculatorService: FeeCalculatorService,
  ) {}

  async calculateSpread(params: {
    symbol: string;
    upbitPrice: number;
    binancePrice: number;
    profitThresholdPercent: number;
    onArbitrageConditionMet: (data: {
      symbol: string;
      upbitPrice: number;
      binancePrice: number;
      rate: number;
      netProfit: number;
      netProfitPercent: number;
    }) => Promise<void>;
  }) {
    const {
      symbol,
      upbitPrice,
      binancePrice,
      profitThresholdPercent,
      onArbitrageConditionMet,
    } = params;

    if (upbitPrice === undefined || binancePrice === undefined) return;

    const rate = await this.exchangeService.getUSDTtoKRW();
    const globalPrice = binancePrice * rate;
    const spread = ((upbitPrice - globalPrice) / globalPrice) * 100;
    const spreadFixed = spread.toFixed(2);

    // this.logger.log(
    //   `📊 [${symbol.toUpperCase()}] Spread: ${spreadFixed}% (환율: ${rate})`,
    // );

    const totalUSDT = 1000;
    const halfUSDT = totalUSDT / 2;
    const buyAmount = binancePrice !== 0 ? halfUSDT / binancePrice : 0;

    const result = this.feeCalculatorService.calculate({
      symbol,
      amount: buyAmount,
      upbitPrice,
      binancePrice,
      rate,
      tradeDirection: 'HIGH_PREMIUM_SELL_UPBIT',
    });

    // this.logger.log(
    //   `✅ [${symbol.toUpperCase()}] 순이익: ${result.netProfit.toFixed(0)}₩ (${result.netProfitPercent.toFixed(2)}%)`,
    // );

    if (result.netProfitPercent > profitThresholdPercent) {
      // this.logger.warn(
      //   `🚨 [${symbol.toUpperCase()}] 순이익률 ${result.netProfitPercent.toFixed(2)}% → 차익거래 조건 만족!`,
      // );

      await onArbitrageConditionMet({
        symbol,
        upbitPrice,
        binancePrice,
        rate,
        netProfit: result.netProfit,
        netProfitPercent: result.netProfitPercent,
      });
    }
  }
}
