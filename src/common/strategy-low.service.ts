// src/common/strategy-low.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { FeeCalculatorService } from './fee-calculator.service';
import { TelegramService } from './telegram.service';
import { ArbitrageRecordService } from '../db/arbitrage-record.service';
import { ArbitrageCycle } from '../db/entities/arbitrage-cycle.entity'; // 이 import는 필요합니다.

@Injectable()
export class StrategyLowService {
  private readonly logger = new Logger(StrategyLowService.name);

  constructor(
    private readonly feeCalculatorService: FeeCalculatorService,
    private readonly telegramService: TelegramService,
    private readonly arbitrageRecordService: ArbitrageRecordService,
  ) {}

  async handleLowPremiumFlow(
    symbol: string,
    upbitPrice: number,
    binancePrice: number,
    rate: number,
    cycleId?: string,
  ) {
    const totalKRW = 13000;
    const halfKRW = totalKRW / 2;
    const buyAmount = upbitPrice !== 0 ? halfKRW / upbitPrice : 0;

    const result = this.feeCalculatorService.calculate({
      symbol,
      amount: buyAmount,
      upbitPrice,
      binancePrice,
      rate,
      tradeDirection: 'LOW_PREMIUM_SELL_BINANCE',
    });

    this.logger.log(
      `🔄 [STRATEGY2] 저프리미엄 → ${symbol.toUpperCase()} 시뮬레이션`,
    );
    this.logger.log(` - 환율: ${rate}`);
    this.logger.log(
      ` - 업비트 매수가: ₩${halfKRW} → ${buyAmount.toFixed(4)} ${symbol.toUpperCase()}`,
    );
    this.logger.log(
      ` - 예상 수익: ${result.netProfit.toFixed(0)}₩ (${result.netProfitPercent.toFixed(2)}%)`,
    );

    if (cycleId) {
      try {
        const existingCycle =
          await this.arbitrageRecordService.getArbitrageCycle(cycleId);
        if (existingCycle) {
          const totalNetProfitKrw =
            (existingCycle.highPremiumNetProfitKrw ?? 0) + result.netProfit;
          const totalNetProfitUsd = totalNetProfitKrw / rate;
          const totalNetProfitPercent =
            (totalNetProfitKrw / (existingCycle.initialInvestmentKrw ?? 1)) *
            100;

          await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
            lowPremiumSymbol: symbol,
            lowPremiumUpbitBuyPriceKrw: upbitPrice,
            lowPremiumBuyAmount: buyAmount,
            lowPremiumSpreadPercent:
              ((binancePrice * rate - upbitPrice) / upbitPrice) * 100,
            lowPremiumShortEntryFeeKrw: result.binanceFuturesEntryFeeKrw,
            lowPremiumBinanceSellPriceUsd: binancePrice,
            lowPremiumTransferFeeKrw: result.transferCoinToBinanceFeeKrw,
            lowPremiumSellFeeKrw: result.binanceSpotSellFeeKrw,
            lowPremiumShortExitFeeKrw: result.binanceFuturesExitFeeKrw,
            lowPremiumNetProfitKrw: result.netProfit,
            lowPremiumNetProfitUsd: result.netProfit / rate,
            endTime: new Date(),
            totalNetProfitKrw: totalNetProfitKrw,
            totalNetProfitUsd: totalNetProfitUsd,
            totalNetProfitPercent: totalNetProfitPercent,
            status: 'COMPLETED',
          });
          this.logger.log(
            `✅ [DB 저장] 저프리미엄 사이클 ${cycleId} 업데이트 및 플로우 완료.`,
          );
        } else {
          this.logger.error(
            `❌ [DB 오류] 사이클 ID ${cycleId}를 찾을 수 없어 저프리미엄 정보 업데이트 실패.`,
          );
        }
      } catch (error) {
        this.logger.error(
          `❌ [DB 오류] 저프리미엄 사이클 ${cycleId} 업데이트 실패: ${error.message}`,
        );
        await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
          status: 'FAILED',
          errorDetails: `저프리미엄 완료 DB 업데이트 실패: ${error.message}`,
        });
      }
    }
  }
}
