// src/common/strategy-high.service.ts
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
    actualInvestmentUSDT?: number,
  ): Promise<{ netProfitKrw: number; totalFeeKrw: number } | void> {
    const investmentUSDTForCalc = actualInvestmentUSDT ?? 10;
    if (actualInvestmentUSDT === undefined) {
      this.logger.warn(
        `[STRATEGY1] actualInvestmentUSDT is undefined, using fallback: ${investmentUSDTForCalc} USDT`,
      );
    }

    const buyAmount =
      binancePrice !== 0 ? investmentUSDTForCalc / binancePrice : 0;

    // FeeCalculatorService는 슬리피지를 시뮬레이션하여 더 현실적인 예상 손익을 계산
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
      ` - 바이낸스 매수가: $${investmentUSDTForCalc} → ${buyAmount.toFixed(4)} ${symbol.toUpperCase()}`,
    );
    this.logger.log(
      ` - 예상 수익: ${result.netProfit.toFixed(0)}₩ (${result.netProfitPercent.toFixed(2)}%)`,
    );

    if (cycleId) {
      try {
        // 시뮬레이션된 단계별 상태 업데이트
        this.logger.log(`[SIMULATE_HP] ${cycleId} - 바이낸스 매수 완료`);
        await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
          status: 'HP_BOUGHT',
        });

        this.logger.log(
          `[SIMULATE_HP] ${cycleId} - 업비트로 전송 시작 (1분 대기)`,
        );
        await new Promise((resolve) => setTimeout(resolve, 60000));
        await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
          status: 'HP_WITHDRAWN',
        });

        this.logger.log(`[SIMULATE_HP] ${cycleId} - 업비트 입금 완료`);
        await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
          status: 'HP_DEPOSITED',
        });

        this.logger.log(
          `[SIMULATE_HP] ${cycleId} - 업비트 매도 완료. 고프리미엄 단계 종료.`,
        );
        await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
          highPremiumUpbitSellPriceKrw: upbitPrice,
          highPremiumTransferFeeKrw: result.transferCoinToUpbitFeeKrw,
          highPremiumSellFeeKrw: result.upbitSellFeeKrw,
          highPremiumNetProfitKrw: result.netProfit,
          highPremiumNetProfitUsd: result.netProfit / rate,
          highPremiumCompletedAt: new Date(),
          // [수정된 부분] 'HIGH_PREMIUM_COMPLETED' 대신 'HP_SOLD' 사용
          status: 'HP_SOLD',
        });

        this.logger.log(
          `✅ [DB 저장] 고프리미엄 사이클 ${cycleId} 업데이트 완료. 최종 상태: HP_SOLD`,
        );
      } catch (error) {
        this.logger.error(
          `❌ [DB 오류] 고프리미엄 사이클 ${cycleId} 업데이트 실패: ${(error as Error).message}`,
        );
        await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
          status: 'FAILED',
          errorDetails: `고프리미엄 완료 DB 업데이트 실패: ${(error as Error).message}`,
        });
      }
    }
  }
}
