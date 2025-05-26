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
    investmentKRW?: number,
  ) {
    const actualInvestmentKRW =
      investmentKRW && investmentKRW > 0 ? investmentKRW : 10_000_000;

    this.logger.log(
      `[STRATEGY_LOW] Received for cycle ${cycleId}: symbol=${symbol}, upbitPrice=${upbitPrice}, binancePrice=${binancePrice}, rate=${rate}, investmentKRW=${actualInvestmentKRW}`,
    );

    const buyAmount = upbitPrice !== 0 ? actualInvestmentKRW / upbitPrice : 0;

    const result = this.feeCalculatorService.calculate({
      symbol,
      amount: buyAmount,
      upbitPrice,
      binancePrice,
      rate,
      tradeDirection: 'LOW_PREMIUM_SELL_BINANCE',
    });

    this.logger.log(
      `[STRATEGY_LOW] Fee calculation result for ${symbol} (cycle ${cycleId}): ${JSON.stringify(result)}`,
    ); // 상세 로깅 추가

    if (cycleId) {
      try {
        const existingCycle =
          await this.arbitrageRecordService.getArbitrageCycle(cycleId);
        if (existingCycle) {
          // --- 숫자형 변환 및 NaN 방어 강화 ---
          const highPremiumProfit = Number(
            existingCycle.highPremiumNetProfitKrw ?? 0,
          );
          const lowPremiumProfit = Number(result.netProfit ?? 0); // result.netProfit도 혹시 모르니 Number로 감싸기

          // highPremiumProfit 또는 lowPremiumProfit이 NaN일 경우 0으로 처리
          const validHighPremiumProfit = isNaN(highPremiumProfit)
            ? 0
            : highPremiumProfit;
          const validLowPremiumProfit = isNaN(lowPremiumProfit)
            ? 0
            : lowPremiumProfit;

          const calculatedTotalNetProfitKrw =
            validHighPremiumProfit + validLowPremiumProfit;

          const initialCycleInvestment = Number(
            existingCycle.initialInvestmentKrw ?? 1,
          );
          const validInitialCycleInvestment = isNaN(initialCycleInvestment)
            ? 1
            : initialCycleInvestment;

          const currentRate = Number(
            rate && !isNaN(rate)
              ? rate
              : (existingCycle.highPremiumInitialRate ?? 1300),
          );
          const validRate =
            isNaN(currentRate) || currentRate === 0 ? 1300 : currentRate; // 0으로 나누는 것 방지

          const calculatedTotalNetProfitUsd =
            calculatedTotalNetProfitKrw / validRate;
          const calculatedTotalNetProfitPercent =
            (calculatedTotalNetProfitKrw / validInitialCycleInvestment) * 100;

          const updateData = {
            lowPremiumSymbol: symbol,
            lowPremiumUpbitBuyPriceKrw: upbitPrice,
            lowPremiumBuyAmount: buyAmount,
            lowPremiumSpreadPercent:
              ((binancePrice * validRate - upbitPrice) / upbitPrice) * 100,
            lowPremiumShortEntryFeeKrw: result.binanceFuturesEntryFeeKrw,
            lowPremiumBinanceSellPriceUsd: binancePrice,
            lowPremiumTransferFeeKrw: result.transferCoinToBinanceFeeKrw,
            lowPremiumSellFeeKrw: result.binanceSpotSellFeeKrw,
            lowPremiumShortExitFeeKrw: result.binanceFuturesExitFeeKrw,
            lowPremiumNetProfitKrw: validLowPremiumProfit, // NaN이 아닌 값으로 저장
            lowPremiumNetProfitUsd: validLowPremiumProfit / validRate, // NaN이 아닌 값으로 저장
            endTime: new Date(),
            totalNetProfitKrw: calculatedTotalNetProfitKrw, // NaN이 아닌 값으로 저장
            totalNetProfitUsd: calculatedTotalNetProfitUsd, // NaN이 아닌 값으로 저장
            totalNetProfitPercent: calculatedTotalNetProfitPercent, // NaN이 아닌 값으로 저장
            status: 'COMPLETED',
          };
          this.logger.log(
            `[STRATEGY_LOW] Updating cycle ${cycleId} with data: ${JSON.stringify(updateData)}`,
          );
          await this.arbitrageRecordService.updateArbitrageCycle(
            cycleId,
            updateData,
          );
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
