// strategy-high.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { FeeCalculatorService } from './fee-calculator.service';
import { TelegramService } from './telegram.service';
import { ArbitrageRecordService } from '../db/arbitrage-record.service';

@Injectable()
export class StrategyHighService {
  private readonly logger = new Logger(StrategyHighService.name);

  constructor(
    private readonly feeCalculatorService: FeeCalculatorService,
    private readonly telegramService: TelegramService,
    private readonly arbitrageRecordService: ArbitrageRecordService,
  ) {}

  async handleHighPremiumFlow(
    symbol: string,
    upbitPrice: number,
    binancePrice: number,
    rate: number,
    cycleId?: string,
  ) {
    const totalUSDT = 10;
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

    this.logger.log(
      `🚀 [STRATEGY1] 고프리미엄 → ${symbol.toUpperCase()} 시뮬레이션`,
    );
    this.logger.log(` - 환율: ${rate}`);
    this.logger.log(
      ` - 바이낸스 매수가: $${halfUSDT} → ${buyAmount.toFixed(4)} ${symbol.toUpperCase()}`,
    );
    this.logger.log(
      ` - 예상 수익: ${result.netProfit.toFixed(0)}₩ (${result.netProfitPercent.toFixed(2)}%)`,
    );

    if (cycleId) {
      try {
        await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
          highPremiumUpbitSellPriceKrw: upbitPrice,
          highPremiumTransferFeeKrw: result.transferCoinToUpbitFeeKrw,
          highPremiumSellFeeKrw: result.upbitSellFeeKrw,
          highPremiumShortEntryFeeKrw: result.binanceFuturesEntryFeeKrw,
          highPremiumShortExitFeeKrw: result.binanceFuturesExitFeeKrw,
          highPremiumNetProfitKrw: result.netProfit,
          highPremiumNetProfitUsd: result.netProfit / rate,
          highPremiumCompletedAt: new Date(),
          status: 'HIGH_PREMIUM_COMPLETED',
        });
        this.logger.log(
          `✅ [DB 저장] 고프리미엄 사이클 ${cycleId} 업데이트 완료.`,
        );
      } catch (error) {
        this.logger.error(
          `❌ [DB 오류] 고프리미엄 사이클 ${cycleId} 업데이트 실패: ${error.message}`,
        );
        await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
          status: 'FAILED',
          errorDetails: `고프리미엄 완료 DB 업데이트 실패: ${error.message}`,
        });
      }
    }
  }
}
