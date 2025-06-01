// src/arbitrage/low-premium-processor.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ArbitrageCycleStateService,
  CycleExecutionStatus,
} from './arbitrage-cycle-state.service';
import {
  PriceFeedService,
  WatchedSymbolConfig,
} from '../marketdata/price-feed.service';
import { ArbitrageRecordService } from '../db/arbitrage-record.service';
import { StrategyLowService } from '../common/strategy-low.service';
import { FeeCalculatorService } from '../common/fee-calculator.service';
import { ExchangeService } from '../common/exchange.service';
import { ArbitrageCycle } from '../db/entities/arbitrage-cycle.entity';

export interface LowPremiumResult {
  success: boolean;
  cycleId: string;
  finalStatus?: ArbitrageCycle | null;
  error?: Error;
}

@Injectable()
export class LowPremiumProcessorService {
  private readonly logger = new Logger(LowPremiumProcessorService.name);

  private readonly watchedSymbols: ReadonlyArray<WatchedSymbolConfig>;
  private readonly INITIAL_TARGET_PROFIT_RATE_PERCENT: number;
  private readonly MINIMUM_ACCEPTABLE_PROFIT_RATE_PERCENT: number;
  private readonly TARGET_ADJUSTMENT_INTERVAL_MS: number;
  private readonly TARGET_ADJUSTMENT_STEP_PERCENT: number;
  private readonly MAX_SEARCH_DURATION_MS: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly cycleStateService: ArbitrageCycleStateService,
    private readonly priceFeedService: PriceFeedService,
    private readonly arbitrageRecordService: ArbitrageRecordService,
    private readonly strategyLowService: StrategyLowService,
    private readonly feeCalculatorService: FeeCalculatorService,
    private readonly exchangeService: ExchangeService,
  ) {
    this.INITIAL_TARGET_PROFIT_RATE_PERCENT =
      this.configService.get<number>(
        'LOW_PREMIUM_INITIAL_TARGET_PROFIT_RATE_PERCENT',
      ) || 0.3;
    this.MINIMUM_ACCEPTABLE_PROFIT_RATE_PERCENT =
      this.configService.get<number>(
        'LOW_PREMIUM_MINIMUM_ACCEPTABLE_PROFIT_RATE_PERCENT',
      ) || 0.05;
    this.TARGET_ADJUSTMENT_INTERVAL_MS =
      this.configService.get<number>(
        'LOW_PREMIUM_TARGET_ADJUSTMENT_INTERVAL_MS',
      ) || 3600000; // 1 hour
    this.TARGET_ADJUSTMENT_STEP_PERCENT =
      this.configService.get<number>(
        'LOW_PREMIUM_TARGET_ADJUSTMENT_STEP_PERCENT',
      ) || 0.05;
    this.MAX_SEARCH_DURATION_MS =
      this.configService.get<number>('LOW_PREMIUM_MAX_SEARCH_DURATION_MS') ||
      86400000; // 24 hours

    this.watchedSymbols = this.priceFeedService.getWatchedSymbols();
    if (!this.watchedSymbols || this.watchedSymbols.length === 0) {
      this.logger.warn(
        'Watched symbols are not configured in LowPremiumProcessorService via PriceFeedService.',
      );
      this.watchedSymbols = [];
    }
  }

  private parseAndValidateNumber(value: any): number | null {
    if (value === null || value === undefined) return null;
    const num = Number(value);
    return isNaN(num) ? null : num;
  }

  public async processLowPremiumOpportunity(): Promise<LowPremiumResult | null> {
    if (
      this.cycleStateService.currentCycleExecutionStatus !==
        CycleExecutionStatus.AWAITING_LOW_PREMIUM ||
      !this.cycleStateService.activeCycleId ||
      this.cycleStateService.requiredLowPremiumNetProfitKrwForActiveCycle ===
        null
    ) {
      this.logger.verbose(
        `[LPP] Skipping. Invalid state or missing data. Status: ${CycleExecutionStatus[this.cycleStateService.currentCycleExecutionStatus]}, CycleID: ${this.cycleStateService.activeCycleId}`,
      );
      return null;
    }

    const activeCycleId = this.cycleStateService.activeCycleId!;
    const requiredProfitKrw =
      this.cycleStateService.requiredLowPremiumNetProfitKrwForActiveCycle!;

    const cycleInfoForLowPremium =
      await this.arbitrageRecordService.getArbitrageCycle(activeCycleId);
    if (
      !cycleInfoForLowPremium ||
      cycleInfoForLowPremium.initialInvestmentKrw === null
    ) {
      this.logger.error(
        `🔴 [LPP] 사이클(${activeCycleId})의 초기 투자금 정보를 찾을 수 없습니다.`,
      );
      await this.arbitrageRecordService.updateArbitrageCycle(activeCycleId, {
        status: 'FAILED',
        errorDetails: '저프 투자금 정보 없음(LPP)',
        endTime: new Date(),
      });
      return {
        success: false,
        cycleId: activeCycleId,
        finalStatus:
          await this.arbitrageRecordService.getArbitrageCycle(activeCycleId),
        error: new Error('Initial investment info not found for low premium.'),
      };
    }
    const lowPremiumInvestmentKRW = this.parseAndValidateNumber(
      cycleInfoForLowPremium.initialInvestmentKrw,
    )!;

    const searchStartTime = this.cycleStateService.lowPremiumSearchStartTime;
    if (!searchStartTime) {
      this.logger.error(
        `[LPP] Low premium search start time not set for cycle ${activeCycleId}.`,
      );
      await this.arbitrageRecordService.updateArbitrageCycle(activeCycleId, {
        status: 'FAILED',
        errorDetails: '저프 탐색 시작 시간 없음(LPP)',
        endTime: new Date(),
      });
      return {
        success: false,
        cycleId: activeCycleId,
        finalStatus:
          await this.arbitrageRecordService.getArbitrageCycle(activeCycleId),
        error: new Error('Search start time not set'),
      };
    }
    const elapsedTimeMs = Date.now() - searchStartTime;

    let currentAdjustedTargetProfitRatePercent =
      this.INITIAL_TARGET_PROFIT_RATE_PERCENT;
    if (
      this.TARGET_ADJUSTMENT_INTERVAL_MS > 0 &&
      this.TARGET_ADJUSTMENT_STEP_PERCENT > 0
    ) {
      const adjustmentIntervalsPassed = Math.floor(
        elapsedTimeMs / this.TARGET_ADJUSTMENT_INTERVAL_MS,
      );
      currentAdjustedTargetProfitRatePercent -=
        adjustmentIntervalsPassed * this.TARGET_ADJUSTMENT_STEP_PERCENT;
    }
    currentAdjustedTargetProfitRatePercent = Math.max(
      this.MINIMUM_ACCEPTABLE_PROFIT_RATE_PERCENT,
      currentAdjustedTargetProfitRatePercent,
    );

    this.logger.verbose(
      `[LPP_SCAN_LOOP] Cycle ID: ${activeCycleId}, Elapsed: ${(elapsedTimeMs / 1000 / 60).toFixed(1)}min, Adjusted Target Rate: ${currentAdjustedTargetProfitRatePercent.toFixed(3)}%, Required KRW Profit for Cycle: ${requiredProfitKrw.toFixed(0)}, Investment: ${lowPremiumInvestmentKRW.toFixed(0)} KRW`,
    );

    // 2. "소프트" 타임아웃 (최대 탐색 기간) 확인
    if (elapsedTimeMs > this.MAX_SEARCH_DURATION_MS) {
      this.logger.warn(
        `[LPP_MAX_DURATION_REACHED_CHECK] 저프리미엄 최대 탐색 기간 초과 (Cycle ID: ${activeCycleId}). 현재 조정된 목표 수익률 ${currentAdjustedTargetProfitRatePercent.toFixed(3)}%로 마지막 탐색 시도.`,
      );
      // ---------------------------------------------------------------------------
      // TODO: 사용자 상호작용 로직 추가 계획 (주석으로 명시)
      // 1. 이 시점에서 사용자(관리자)에게 텔레그램으로 알림을 보낸다.
      //    - 알림 내용: "사이클 ID XXXXX의 저프리미엄 탐색이 최대 기간(Y시간)을 초과했습니다. 현재 목표 수익률 Z%로 탐색 중입니다."
      //    - 선택 옵션 제공:
      //      a) "현재 조건으로 계속 탐색" (또는 "최소 수익률로 마지막 탐색 후 자동 종료")
      //      b) "즉시 사이클 종료 (고프 수익만 확정)"
      //      c) "새로운 최소 허용 수익률 입력" (예: 사용자가 0.01% 입력)
      //
      // 2. 사용자 응답 대기 (짧은 시간, 예: 5~10분).
      //    - 응답 시간 내에 특정 명령어가 오면 해당 액션 수행.
      //    - 응답이 없거나 "계속 탐색" 옵션 선택 시, 아래 로직(최소 수익률로 마지막 탐색) 자동 진행.
      //    - "즉시 종료" 시, HIGH_PREMIUM_ONLY_COMPLETED_TARGET_MISSED 상태로 DB 업데이트 후 결과 반환.
      //    - "새로운 최소 허용 수익률 입력" 시, currentAdjustedTargetProfitRatePercent를 해당 값으로 업데이트하고 아래 탐색 진행.
      //
      // 3. 현재는 이 로직이 구현되지 않았으므로, 아래의 기회 탐색 로직이
      //    MAX_SEARCH_DURATION_MS가 경과한 시점의 currentAdjustedTargetProfitRatePercent (아마도 MINIMUM_ACCEPTABLE_PROFIT_RATE_PERCENT에 가까움)
      //    으로 한 번 더 실행되고, 그래도 기회가 없으면 bestLowPremiumOpportunity가 null이 되어
      //    아래쪽의 최종 MAX_SEARCH_DURATION_MS 초과 시 종료 로직을 타게 됩니다.
      // ---------------------------------------------------------------------------
    }

    let bestLowPremiumOpportunity: {
      symbol: string;
      upbitPrice: number;
      binancePrice: number;
      expectedNetProfitKrw: number;
      expectedNetProfitRatePercent: number;
      rate: number;
    } | null = null;
    const currentRateForLowPremium = await this.exchangeService.getUSDTtoKRW();
    if (currentRateForLowPremium === null) {
      this.logger.error(
        '[LPP_SCAN_LOOP] USDT to KRW 환율 정보를 가져올 수 없습니다.',
      );
      return null;
    }

    const highPremiumSymbolForCurrentCycle =
      cycleInfoForLowPremium?.highPremiumSymbol;

    for (const watched of this.watchedSymbols) {
      if (
        highPremiumSymbolForCurrentCycle &&
        watched.symbol === highPremiumSymbolForCurrentCycle
      )
        continue;

      const upbitPrice = this.priceFeedService.getUpbitPrice(watched.symbol);
      const binancePrice = this.priceFeedService.getBinancePrice(
        watched.symbol,
      );

      if (upbitPrice && binancePrice && lowPremiumInvestmentKRW > 0) {
        const amount = lowPremiumInvestmentKRW / upbitPrice;
        if (amount <= 0 || isNaN(amount)) continue;

        const feeResult = this.feeCalculatorService.calculate({
          symbol: watched.symbol,
          amount,
          upbitPrice,
          binancePrice,
          rate: currentRateForLowPremium,
          tradeDirection: 'LOW_PREMIUM_SELL_BINANCE',
        });

        const currentNetProfitRatePercent =
          feeResult.netProfitPercent !== undefined
            ? feeResult.netProfitPercent
            : (feeResult.netProfit / lowPremiumInvestmentKRW) * 100;

        if (
          currentNetProfitRatePercent >= currentAdjustedTargetProfitRatePercent
        ) {
          const meetsCycleTargetCondition =
            (requiredProfitKrw < 0 && feeResult.netProfit >= 0) ||
            (requiredProfitKrw >= 0 &&
              feeResult.netProfit >= requiredProfitKrw) ||
            (requiredProfitKrw >= 0 &&
              feeResult.netProfit >= 0 &&
              currentNetProfitRatePercent >=
                this.INITIAL_TARGET_PROFIT_RATE_PERCENT);

          if (meetsCycleTargetCondition) {
            if (
              !bestLowPremiumOpportunity ||
              currentNetProfitRatePercent >
                bestLowPremiumOpportunity.expectedNetProfitRatePercent
            ) {
              bestLowPremiumOpportunity = {
                symbol: watched.symbol,
                upbitPrice,
                binancePrice,
                expectedNetProfitKrw: feeResult.netProfit,
                expectedNetProfitRatePercent: currentNetProfitRatePercent,
                rate: currentRateForLowPremium,
              };
            }
          }
        }
      }
    }

    if (bestLowPremiumOpportunity) {
      if (!this.cycleStateService.startLowPremiumProcessing()) {
        this.logger.warn(
          `[LPP_FOUND_BUT_SKIPPED] 상태 변경 실패. ${bestLowPremiumOpportunity.symbol.toUpperCase()} 건너뜁니다. (Cycle ID: ${activeCycleId})`,
        );
        return null;
      }
      this.logger.log(
        `✅ [LPP_FOUND] 최적 코인: ${bestLowPremiumOpportunity.symbol.toUpperCase()} (예상 수익: ${bestLowPremiumOpportunity.expectedNetProfitKrw.toFixed(0)} KRW, 예상 수익률: ${bestLowPremiumOpportunity.expectedNetProfitRatePercent.toFixed(3)}%). 투자금 ${lowPremiumInvestmentKRW.toFixed(0)} KRW로 저프리미엄 단계 진행.`,
      );

      try {
        const randomSeconds = Math.floor(Math.random() * (300 - 60 + 1)) + 60;
        this.logger.log(
          `⬅️ [SIMULATE_LPP] 저프리미엄 ${bestLowPremiumOpportunity.symbol.toUpperCase()} 매수/송금 시작 (${(randomSeconds / 60).toFixed(1)}분 대기)`,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, randomSeconds * 1000),
        );

        await this.strategyLowService.handleLowPremiumFlow(
          bestLowPremiumOpportunity.symbol,
          bestLowPremiumOpportunity.upbitPrice,
          bestLowPremiumOpportunity.binancePrice,
          bestLowPremiumOpportunity.rate,
          activeCycleId,
          lowPremiumInvestmentKRW,
        );
        this.logger.log(
          `✅ [SIMULATE_LPP] 저프리미엄 ${bestLowPremiumOpportunity.symbol.toUpperCase()} 매매/송금 시뮬레이션 완료.`,
        );

        const finalCycleStatus =
          await this.arbitrageRecordService.getArbitrageCycle(activeCycleId);
        if (!finalCycleStatus || finalCycleStatus.status !== 'COMPLETED') {
          throw new Error(
            `저프리미엄 단계 (${activeCycleId}) 후 사이클이 DB에서 COMPLETED 상태로 확인되지 않았습니다 (LPP): ${finalCycleStatus?.status}`,
          );
        }
        return {
          success: true,
          cycleId: activeCycleId,
          finalStatus: finalCycleStatus,
        };
      } catch (error) {
        this.logger.error(
          `❌ [LPP_ERROR] 저프리미엄 처리 중 오류 (Cycle ID: ${activeCycleId}): ${(error as Error).message}`,
          (error as Error).stack,
        );
        await this.arbitrageRecordService.updateArbitrageCycle(activeCycleId, {
          status: 'FAILED',
          errorDetails: `저프리미엄 처리 중 오류 LPP: ${(error as Error).message}`,
          endTime: new Date(),
        });
        return {
          success: false,
          cycleId: activeCycleId,
          finalStatus:
            await this.arbitrageRecordService.getArbitrageCycle(activeCycleId),
          error: error as Error,
        };
      }
    } else {
      // 최대 탐색 기간이 지났고, 여전히 기회를 못 찾았다면 사이클을 목표 미달로 종료
      if (elapsedTimeMs > this.MAX_SEARCH_DURATION_MS) {
        this.logger.warn(
          `[LPP_MAX_DURATION_NO_OPP] 최대 탐색 기간 후에도 저프리미엄 기회 없음 (Cycle ID: ${activeCycleId}). 사이클 종료.`,
        );
        const highPremiumResult =
          await this.arbitrageRecordService.getArbitrageCycle(activeCycleId);
        const actualHighPremiumNetProfitKrw = this.parseAndValidateNumber(
          highPremiumResult?.highPremiumNetProfitKrw,
        );
        await this.arbitrageRecordService.updateArbitrageCycle(activeCycleId, {
          status: 'HIGH_PREMIUM_ONLY_COMPLETED_TARGET_MISSED',
          errorDetails: `최대 탐색 기간(${(this.MAX_SEARCH_DURATION_MS / 1000 / 60 / 60).toFixed(1)}h) 후 저프리미엄 기회 없음. 최종 조정 목표 수익률: ${currentAdjustedTargetProfitRatePercent.toFixed(3)}% (LPP)`,
          endTime: new Date(),
          totalNetProfitKrw: actualHighPremiumNetProfitKrw,
          totalNetProfitUsd:
            actualHighPremiumNetProfitKrw !== null &&
            this.cycleStateService.highPremiumInitialRateForActiveCycle !== null
              ? actualHighPremiumNetProfitKrw /
                this.cycleStateService.highPremiumInitialRateForActiveCycle
              : null,
          totalNetProfitPercent:
            actualHighPremiumNetProfitKrw !== null &&
            lowPremiumInvestmentKRW > 0 &&
            cycleInfoForLowPremium.initialInvestmentKrw
              ? (actualHighPremiumNetProfitKrw /
                  (this.parseAndValidateNumber(
                    cycleInfoForLowPremium.initialInvestmentKrw,
                  )! *
                    1)) *
                100
              : null,
        });
        return {
          success: false,
          cycleId: activeCycleId,
          finalStatus:
            await this.arbitrageRecordService.getArbitrageCycle(activeCycleId),
          error: new Error('Max search duration reached with no opportunity.'),
        };
      }
      this.logger.verbose(
        `[LPP_SCAN_LOOP] 이번 주기에 적합한 저프리미엄 코인 없음. 계속 탐색. (Cycle ID: ${activeCycleId})`,
      );
      return null; // 아직 기회 없음 (최대 탐색 기간 전)
    }
  }
}
