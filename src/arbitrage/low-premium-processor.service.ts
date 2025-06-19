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
import { SlippageCalculatorService } from 'src/common/slippage-calculator.service';

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
  private readonly MAX_SEARCH_DURATION_MS: number;
  private readonly MINIMUM_VOLUME_KRW = 5000000000; // 최소 거래대금 100억 원

  constructor(
    private readonly configService: ConfigService,
    private readonly cycleStateService: ArbitrageCycleStateService,
    private readonly priceFeedService: PriceFeedService,
    private readonly arbitrageRecordService: ArbitrageRecordService,
    private readonly strategyLowService: StrategyLowService,
    private readonly feeCalculatorService: FeeCalculatorService,
    private readonly exchangeService: ExchangeService,
    private readonly slippageCalculatorService: SlippageCalculatorService, // ⭐️ 주입 추가
  ) {
    this.logger.log(
      `[초기화] LowPremiumProcessorService 초기화 완료. 최소 거래대금 기준: ${(this.MINIMUM_VOLUME_KRW / 100000000).toFixed(2)}억 KRW`,
    );

    this.MAX_SEARCH_DURATION_MS =
      this.configService.get<number>('LOW_PREMIUM_MAX_SEARCH_DURATION_MS') ||
      60000 * 60; // 1 hour

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

    let bestLowPremiumOpportunity: {
      symbol: string;
      upbitPrice: number;
      binancePrice: number;
      expectedNetProfitKrw: number;
      expectedNetProfitRatePercent: number;
      rate: number;
    } | null = null;

    const currentRateForLowPremium = this.exchangeService.getUSDTtoKRW();
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
        // 유동성 필터링 로직을 이 곳에 적용합니다.
        try {
          const upbitTickerInfo = await this.exchangeService.getTickerInfo(
            'upbit',
            watched.symbol,
          );
          const upbitVolume24h = upbitTickerInfo.quoteVolume;

          if (upbitVolume24h < this.MINIMUM_VOLUME_KRW) {
            this.logger.verbose(
              `[LP_FILTERED] Skipped ${watched.symbol} due to low trading volume: ${(upbitVolume24h / 100000000).toFixed(2)}억 KRW`,
            );
            continue; // 거래량이 적으면 다음 코인으로 넘어감
          }
        } catch (error) {
          this.logger.warn(
            `[LP_FILTER] Failed to get ticker info for ${watched.symbol}: ${error.message}`,
          );
          continue; // 티커 정보 조회 실패 시에도 다음 코인으로 넘어감
        }

        let slippagePercent = 0;
        try {
          const upbitOrderBook = await this.exchangeService.getOrderBook(
            'upbit',
            watched.symbol,
          );
          const slippageResult = this.slippageCalculatorService.calculate(
            upbitOrderBook,
            'buy', // LP 단계는 업비트에서 '매수'로 시작
            lowPremiumInvestmentKRW,
          );
          slippagePercent = slippageResult.slippagePercent;

          // 예상 슬리피지가 너무 크면(예: 1%) 해당 코인 건너뛰기
          if (slippagePercent > 1) {
            this.logger.verbose(
              `[LP_FILTER] Skipped ${watched.symbol} (High Slippage: ${slippagePercent.toFixed(2)}%)`,
            );
            continue;
          }
        } catch (error) {
          this.logger.warn(
            `[LP_FILTER] Failed to check slippage for ${watched.symbol}: ${error.message}`,
          );
          continue;
        }

        const amount = lowPremiumInvestmentKRW / upbitPrice; // 근사치 수량
        if (amount <= 0 || isNaN(amount)) continue;

        const feeResult = this.feeCalculatorService.calculate({
          symbol: watched.symbol,
          amount,
          upbitPrice, // 슬리피지 계산기에서 나온 평균 체결가를 사용하면 더 정확
          binancePrice,
          rate: currentRateForLowPremium,
          tradeDirection: 'LOW_PREMIUM_SELL_BINANCE',
        });

        // feeResult.netProfitPercent에서 예상 슬리피지를 차감하여 최종 기대 수익률 계산
        const finalExpectedProfitPercent =
          feeResult.netProfitPercent - slippagePercent;
        const finalExpectedProfitKrw =
          feeResult.netProfit -
          (lowPremiumInvestmentKRW * slippagePercent) / 100;

        // this.logger.log(
        //   `[LPP_EVAL] ${watched.symbol.toUpperCase()}: NetProfitKRW: ${feeResult.netProfit.toFixed(0)} vs RequiredKRW: ${requiredProfitKrw.toFixed(0)}`,
        // );

        // 최종 수정된 로직: 이 거래의 실제 손익(NetProfitKrw)이 사이클 목표를 위해
        // 감수 가능한 손익(RequiredKrw)보다 좋은지 여부만 확인합니다.
        if (finalExpectedProfitKrw >= requiredProfitKrw) {
          if (
            !bestLowPremiumOpportunity ||
            finalExpectedProfitKrw >
              bestLowPremiumOpportunity.expectedNetProfitKrw
          ) {
            bestLowPremiumOpportunity = {
              symbol: watched.symbol,
              upbitPrice,
              binancePrice,
              expectedNetProfitKrw: finalExpectedProfitKrw,
              expectedNetProfitRatePercent: finalExpectedProfitPercent,
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
        return null;
      }
      this.logger.log(
        `✅ [LPP_FOUND] 최적 코인: ${bestLowPremiumOpportunity.symbol.toUpperCase()} (예상 손익: ${bestLowPremiumOpportunity.expectedNetProfitKrw.toFixed(0)} KRW, 예상 수익률: ${bestLowPremiumOpportunity.expectedNetProfitRatePercent.toFixed(3)}%). 투자금 ${lowPremiumInvestmentKRW.toFixed(0)} KRW로 저프리미엄 단계 진행.`,
      );

      try {
        // .env 파일의 UPBIT_MODE 설정을 가져옵니다. (저프리미엄은 업비트에서 시작)
        const mode = this.configService.get<string>('UPBIT_MODE');

        if (mode === 'REAL') {
          // ========== REAL 모드 실행 블록 ==========
          this.logger.warn(
            `[REAL-MODE] 🔄 [LOW_PREMIUM_START] ${bestLowPremiumOpportunity.symbol.toUpperCase()} 실제 거래 시작. (ID: ${activeCycleId})`,
          );

          // 시뮬레이션 시간 지연 없이, 실제 거래 흐름을 담당하는 서비스를 직접 호출합니다.
          await this.strategyLowService.handleLowPremiumFlow(
            bestLowPremiumOpportunity.symbol,
            bestLowPremiumOpportunity.upbitPrice,
            bestLowPremiumOpportunity.binancePrice,
            bestLowPremiumOpportunity.rate,
            activeCycleId,
            lowPremiumInvestmentKRW,
          );

          this.logger.log(
            `✅ [REAL-MODE] 저프리미엄 ${bestLowPremiumOpportunity.symbol.toUpperCase()} 모든 단계 처리 완료.`,
          );
        } else {
          // ========== SIMULATION 모드 실행 블록 (기존 로직) ==========
          const randomSeconds = Math.floor(Math.random() * (60 - 60 + 1)) + 60;
          this.logger.log(
            `⬅️ [SIMULATE_LPP] 저프리미엄 ${bestLowPremiumOpportunity.symbol.toUpperCase()} 매수/송금 시작 (${(randomSeconds / 60).toFixed(1)}분 대기)`,
          );
          await new Promise((resolve) =>
            setTimeout(resolve, randomSeconds * 1000),
          );

          // 시뮬레이션 모드에서도 이 함수를 호출하는 것은 기존 로직과 동일
          await this.strategyLowService.handleLowPremiumFlow(
            bestLowPremiumOpportunity.symbol,
            bestLowPremiumOpportunity.upbitPrice,
            bestLowPremiumOpportunity.binancePrice,
            bestLowPremiumOpportunity.rate,
            activeCycleId,
            lowPremiumInvestmentKRW,
          );
        }

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
    }

    // 타임아웃 로직
    const elapsedTimeMs = Date.now() - searchStartTime;
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
        status: 'HP_ONLY_COMPLETED_TARGET_MISSED',
        errorDetails: `최대 탐색 기간(${(this.MAX_SEARCH_DURATION_MS / 1000 / 60 / 60).toFixed(1)}h) 후 저프리미엄 기회 없음. (LPP)`,
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
                this.parseAndValidateNumber(
                  cycleInfoForLowPremium.initialInvestmentKrw,
                )!) *
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

    // 아직 기회를 못 찾았고 타임아웃도 아니라면 null을 반환하여 다음을 기약
    return null;
  }
}
