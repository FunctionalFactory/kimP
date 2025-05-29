// src/arbitrage/high-premium-processor.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ArbitrageCycleStateService,
  CycleExecutionStatus,
} from './arbitrage-cycle-state.service';
import { PortfolioLogService } from '../db/portfolio-log.service';
import { ArbitrageRecordService } from '../db/arbitrage-record.service';
import { ArbitrageService } from '../common/arbitrage.service';
import { ArbitrageCycle } from '../db/entities/arbitrage-cycle.entity';
import { PortfolioLog } from '../db/entities/portfolio-log.entity';
// import { LowPremiumProcessorService } from './low-premium-processor.service'; // 순환 의존성 주의, 이벤트 방식 또는 FlowManager 경유
// import { CycleCompletionService } from './cycle-completion.service.ts'; // 순환 의존성 주의

// SpreadCalculatorService의 onArbitrageConditionMet 콜백에서 전달되는 데이터 타입
export interface HighPremiumConditionData {
  symbol: string;
  upbitPrice: number;
  binancePrice: number;
  rate: number;
  netProfit: number; // 예상 순이익 (수수료 고려)
  netProfitPercent: number; // 예상 순이익률
}

@Injectable()
export class HighPremiumProcessorService {
  private readonly logger = new Logger(HighPremiumProcessorService.name);

  private readonly TARGET_OVERALL_CYCLE_PROFIT_PERCENT: number;
  private readonly INITIAL_CAPITAL_KRW: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly cycleStateService: ArbitrageCycleStateService,
    private readonly portfolioLogService: PortfolioLogService,
    private readonly arbitrageRecordService: ArbitrageRecordService,
    private readonly arbitrageService: ArbitrageService, // 고프리미엄 거래 시뮬레이션용
    // private readonly lowPremiumProcessorService: LowPremiumProcessorService, // 직접 호출 대신 FlowManager 경유 또는 이벤트 사용
    // private readonly cycleCompletionService: CycleCompletionService, // 직접 호출 대신 FlowManager 경유 또는 이벤트 사용
  ) {
    this.TARGET_OVERALL_CYCLE_PROFIT_PERCENT =
      this.configService.get<number>('TARGET_OVERALL_CYCLE_PROFIT_PERCENT') ||
      0.1;
    this.INITIAL_CAPITAL_KRW =
      this.configService.get<number>('INITIAL_CAPITAL_KRW') || 1500000;
  }

  private parseAndValidateNumber(value: any): number | null {
    if (value === null || value === undefined) return null;
    const num = Number(value);
    return isNaN(num) ? null : num;
  }

  public async processHighPremiumOpportunity(
    data: HighPremiumConditionData,
    // cycleCompletionService: CycleCompletionService, // 메서드 인자로 전달하거나, 이벤트를 통해 호출
    // lowPremiumProcessorService: LowPremiumProcessorService // 메서드 인자로 전달하거나, 이벤트를 통해 호출
  ): Promise<{
    success: boolean;
    nextStep?: 'awaitLowPremium' | 'failed';
    cycleId?: string | null;
  }> {
    this.logger.log(`Processing high premium opportunity for ${data.symbol}`);

    let latestPortfolioLog =
      await this.portfolioLogService.getLatestPortfolio();
    let currentTotalKRWCapital: number;

    if (latestPortfolioLog && latestPortfolioLog.total_balance_krw !== null) {
      currentTotalKRWCapital =
        this.parseAndValidateNumber(latestPortfolioLog.total_balance_krw) ||
        this.INITIAL_CAPITAL_KRW;
    } else {
      currentTotalKRWCapital = this.INITIAL_CAPITAL_KRW;
      this.logger.warn(
        `No portfolio log, starting with initial capital: ${currentTotalKRWCapital.toFixed(0)} KRW`,
      );
      latestPortfolioLog = await this.portfolioLogService.createLog({
        timestamp: new Date(),
        upbit_balance_krw: currentTotalKRWCapital,
        binance_balance_krw: 0,
        total_balance_krw: currentTotalKRWCapital,
        cycle_pnl_krw: 0,
        cycle_pnl_rate_percent: 0,
        remarks: 'System Start: Initial capital set for High Premium.',
      });
    }

    if (currentTotalKRWCapital <= 0) {
      this.logger.error(
        `Total capital is ${currentTotalKRWCapital.toFixed(0)} KRW. Cannot start arbitrage.`,
      );
      return { success: false, nextStep: 'failed' };
    }

    const highPremiumInvestmentKRW = currentTotalKRWCapital;
    const highPremiumInitialRate = data.rate;
    const highPremiumInvestmentUSDT =
      highPremiumInvestmentKRW / highPremiumInitialRate;
    let tempCycleIdRecord: ArbitrageCycle | null = null;

    try {
      tempCycleIdRecord =
        await this.arbitrageRecordService.createArbitrageCycle({
          startTime: new Date(),
          initialInvestmentKrw: highPremiumInvestmentKRW,
          initialInvestmentUsd: highPremiumInvestmentUSDT,
          highPremiumSymbol: data.symbol,
          highPremiumBinanceBuyPriceUsd: data.binancePrice,
          highPremiumInitialRate: highPremiumInitialRate,
          highPremiumBuyAmount:
            data.binancePrice !== 0
              ? highPremiumInvestmentUSDT / data.binancePrice
              : 0,
          highPremiumSpreadPercent:
            ((data.upbitPrice - data.binancePrice * highPremiumInitialRate) /
              (data.binancePrice * highPremiumInitialRate)) *
            100,
          status: 'IN_PROGRESS',
        });

      this.cycleStateService.startHighPremiumProcessing(
        tempCycleIdRecord.id,
        latestPortfolioLog,
      );

      this.logger.warn(
        `✨ [HIGH_PREMIUM_START] ${data.symbol.toUpperCase()} ... 총 자본 ${highPremiumInvestmentKRW.toFixed(0)} KRW로 사이클 시작! (ID: ${this.cycleStateService.activeCycleId})`,
      );

      const randomSeconds = Math.floor(Math.random() * (300 - 60 + 1)) + 60;
      this.logger.log(
        `➡️ [SIMULATE] 고프리미엄 ${data.symbol.toUpperCase()} 매수 및 송금 시작 (${(randomSeconds / 60).toFixed(1)}분 대기)`,
      );
      await new Promise((resolve) => setTimeout(resolve, randomSeconds * 1000));

      await this.arbitrageService.simulateArbitrage(
        {
          symbol: data.symbol,
          upbitPrice: data.upbitPrice,
          binancePrice: data.binancePrice,
          rate: highPremiumInitialRate,
        },
        this.cycleStateService.activeCycleId!,
        highPremiumInvestmentUSDT,
      );

      this.logger.log(
        `✅ [SIMULATE] 고프리미엄 ${data.symbol.toUpperCase()} 매매/송금 시뮬레이션 완료.`,
      );

      const highPremiumCompletedCycle =
        await this.arbitrageRecordService.getArbitrageCycle(
          this.cycleStateService.activeCycleId!,
        );
      if (
        !highPremiumCompletedCycle ||
        highPremiumCompletedCycle.status !== 'HIGH_PREMIUM_COMPLETED'
      ) {
        throw new Error(
          `고프리미엄 단계 (${this.cycleStateService.activeCycleId})가 DB에서 HIGH_PREMIUM_COMPLETED 상태로 확인되지 않았습니다. Status: ${highPremiumCompletedCycle?.status}`,
        );
      }

      const actualHighPremiumNetProfitKrw = this.parseAndValidateNumber(
        highPremiumCompletedCycle.highPremiumNetProfitKrw,
      );
      if (actualHighPremiumNetProfitKrw === null) {
        throw new Error(
          `고프리미엄 순이익(KRW)을 DB에서 가져올 수 없습니다 (사이클 ID: ${this.cycleStateService.activeCycleId}).`,
        );
      }
      this.logger.log(
        `📈 [HIGH_PREMIUM_RESULT] ${data.symbol.toUpperCase()} 실제 순이익: ${actualHighPremiumNetProfitKrw.toFixed(0)} KRW`,
      );

      const overallTargetProfitKrw =
        (currentTotalKRWCapital * this.TARGET_OVERALL_CYCLE_PROFIT_PERCENT) /
        100;
      const requiredLowPremiumProfit =
        overallTargetProfitKrw - actualHighPremiumNetProfitKrw;

      this.cycleStateService.completeHighPremiumAndAwaitLowPremium(
        requiredLowPremiumProfit,
        highPremiumInitialRate,
      );
      this.logger.log(
        `🎯 [AWAITING_LOW_PREMIUM] 고프리미엄 완료. 저프리미엄 탐색 준비. (Cycle ID: ${this.cycleStateService.activeCycleId}, 필요 최소 수익 KRW: ${requiredLowPremiumProfit.toFixed(0)})`,
      );

      return {
        success: true,
        nextStep: 'awaitLowPremium',
        cycleId: this.cycleStateService.activeCycleId,
      };
    } catch (error) {
      const cycleIdToLog =
        this.cycleStateService.activeCycleId || tempCycleIdRecord?.id;
      this.logger.error(
        `❌ [HIGH_PREMIUM_PROCESSOR_ERROR] 고프리미엄 처리 중 오류 (Cycle ID: ${cycleIdToLog || 'N/A'}): ${(error as Error).message}`,
        (error as Error).stack,
      );

      if (cycleIdToLog) {
        await this.arbitrageRecordService.updateArbitrageCycle(cycleIdToLog, {
          status: 'FAILED',
          errorDetails: `고프리미엄 처리 중 예외: ${(error as Error).message}`,
          endTime: new Date(),
        });
        // 실패 시 후처리는 CycleCompletionService에 위임 (FlowManager가 호출)
        // const failedCycleData = await this.arbitrageRecordService.getArbitrageCycle(cycleIdToLog);
        // await cycleCompletionService.completeCycle(cycleIdToLog, failedCycleData, this.cycleStateService.latestPortfolioLogAtCycleStart);
      }
      // 상태 초기화는 CycleCompletionService에서 하거나, FlowManager가 최종적으로 수행
      // this.cycleStateService.resetCycleState();
      return { success: false, nextStep: 'failed', cycleId: cycleIdToLog };
    }
  }
}
