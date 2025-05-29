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
} from '../marketdata/price-feed.service'; // WatchedSymbolConfig 임포트
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

  private readonly LOW_PREMIUM_SEARCH_TIMEOUT_MS: number;
  private readonly watchedSymbols: ReadonlyArray<WatchedSymbolConfig>;

  constructor(
    private readonly configService: ConfigService,
    private readonly cycleStateService: ArbitrageCycleStateService,
    private readonly priceFeedService: PriceFeedService,
    private readonly arbitrageRecordService: ArbitrageRecordService,
    private readonly strategyLowService: StrategyLowService,
    private readonly feeCalculatorService: FeeCalculatorService,
    private readonly exchangeService: ExchangeService,
  ) {
    this.LOW_PREMIUM_SEARCH_TIMEOUT_MS =
      this.configService.get<number>('LOW_PREMIUM_SEARCH_TIMEOUT_MS') ||
      5 * 60 * 1000;
    this.watchedSymbols = this.priceFeedService.getWatchedSymbols(); // PriceFeedService의 public getter 사용
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
        `[LPP] Skipping. State: ${CycleExecutionStatus[this.cycleStateService.currentCycleExecutionStatus]}, CycleID: ${this.cycleStateService.activeCycleId}, RequiredProfit: ${this.cycleStateService.requiredLowPremiumNetProfitKrwForActiveCycle}`,
      );
      return null;
    }

    const activeCycleId = this.cycleStateService.activeCycleId!;
    const requiredProfit =
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
        errorDetails: '저프리미엄 단계 투자금 정보 없음 (LPP)',
        endTime: new Date(),
      });
      const failedData =
        await this.arbitrageRecordService.getArbitrageCycle(activeCycleId);
      return {
        success: false,
        cycleId: activeCycleId,
        finalStatus: failedData,
        error: new Error('Initial investment info not found for low premium.'),
      };
    }
    const lowPremiumInvestmentKRW = this.parseAndValidateNumber(
      cycleInfoForLowPremium.initialInvestmentKrw,
    )!;

    if (
      this.cycleStateService.lowPremiumSearchStartTime &&
      Date.now() - this.cycleStateService.lowPremiumSearchStartTime >
        this.LOW_PREMIUM_SEARCH_TIMEOUT_MS
    ) {
      this.logger.warn(
        `[LPP_TIMEOUT] 저프리미엄 탐색 시간 초과 (Cycle ID: ${activeCycleId}). 목표 미달로 사이클 종료.`,
      );
      const highPremiumResult =
        await this.arbitrageRecordService.getArbitrageCycle(activeCycleId);
      const actualHighPremiumNetProfitKrw = this.parseAndValidateNumber(
        highPremiumResult?.highPremiumNetProfitKrw,
      );
      await this.arbitrageRecordService.updateArbitrageCycle(activeCycleId, {
        status: 'HIGH_PREMIUM_ONLY_COMPLETED_TARGET_MISSED',
        errorDetails: `저프리미엄 탐색 시간 초과 LPP (필요 최소 수익 ${requiredProfit.toFixed(0)} KRW).`,
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
                )! * // 고프와 저프 투자금이 같다면 * 1, 다르다면 합산 또는 다른 기준
                  (cycleInfoForLowPremium.lowPremiumSymbol ? 2 : 1))) * // 예시: 저프까지 완료 시 투자금 2배로 수익률 계산
              100
            : null,
      });
      const timeoutData =
        await this.arbitrageRecordService.getArbitrageCycle(activeCycleId);
      return {
        success: false,
        cycleId: activeCycleId,
        finalStatus: timeoutData,
        error: new Error('Low premium search timeout.'),
      };
    }

    this.logger.verbose(
      `[LPP_SCAN_LOOP] 저프리미엄 기회 탐색 중... (Cycle ID: ${activeCycleId}, 필요 수익: ${requiredProfit.toFixed(0)}, 투자금 ${lowPremiumInvestmentKRW.toFixed(0)} KRW)`,
    );

    let bestLowPremiumOpportunity: {
      symbol: string;
      upbitPrice: number;
      binancePrice: number;
      expectedNetProfitKrw: number;
      rate: number;
    } | null = null;
    const currentRateForLowPremium = await this.exchangeService.getUSDTtoKRW();
    if (currentRateForLowPremium === null) {
      this.logger.error(
        '[LPP_SCAN_LOOP] USDT to KRW 환율 정보를 가져올 수 없습니다.',
      );
      return null; // 환율 정보 없으면 기회 탐색 불가
    }

    const highPremiumSymbolForCurrentCycle =
      cycleInfoForLowPremium?.highPremiumSymbol;

    for (const watched of this.watchedSymbols) {
      // PriceFeedService로부터 받은 심볼 목록 사용
      if (
        highPremiumSymbolForCurrentCycle &&
        watched.symbol === highPremiumSymbolForCurrentCycle
      )
        continue;

      const upbitPrice = this.priceFeedService.getUpbitPrice(watched.symbol);
      const binancePrice = this.priceFeedService.getBinancePrice(
        watched.symbol,
      );

      if (upbitPrice && binancePrice) {
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

        if (feeResult.netProfit >= requiredProfit) {
          if (
            !bestLowPremiumOpportunity ||
            feeResult.netProfit > bestLowPremiumOpportunity.expectedNetProfitKrw
          ) {
            bestLowPremiumOpportunity = {
              symbol: watched.symbol,
              upbitPrice,
              binancePrice,
              expectedNetProfitKrw: feeResult.netProfit,
              rate: currentRateForLowPremium,
            };
          }
        }
      }
    }

    if (bestLowPremiumOpportunity) {
      if (!this.cycleStateService.startLowPremiumProcessing()) {
        this.logger.warn(
          `[LPP_FOUND_BUT_SKIPPED] 상태 변경 실패. ${bestLowPremiumOpportunity.symbol.toUpperCase()} 건너뜁니다. (Cycle ID: ${activeCycleId})`,
        );
        return null; // 상태 변경 실패 시 더 이상 진행 안 함
      }
      this.logger.log(
        `✅ [LPP_FOUND] 최적 코인: ${bestLowPremiumOpportunity.symbol.toUpperCase()} (예상 수익: ${bestLowPremiumOpportunity.expectedNetProfitKrw.toFixed(0)} KRW). 투자금 ${lowPremiumInvestmentKRW.toFixed(0)} KRW로 저프리미엄 단계 진행.`,
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
        const failedData =
          await this.arbitrageRecordService.getArbitrageCycle(activeCycleId);
        return {
          success: false,
          cycleId: activeCycleId,
          finalStatus: failedData,
          error: error as Error,
        };
      }
    } else {
      this.logger.verbose(
        `[LPP_SCAN_LOOP] 이번 주기에 적합한 저프리미엄 코인 없음. 계속 탐색. (Cycle ID: ${activeCycleId})`,
      );
      return null; // 기회 없음
    }
  }
}
