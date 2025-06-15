// src/arbitrage/arbitrage-flow-manager.service.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ArbitrageCycleStateService,
  CycleExecutionStatus,
} from './arbitrage-cycle-state.service';
import { PriceFeedService } from '../marketdata/price-feed.service';
import { SpreadCalculatorService } from '../common/spread-calculator.service';
import { HighPremiumProcessorService } from './high-premium-processor.service';
import {
  LowPremiumProcessorService,
  LowPremiumResult,
} from './low-premium-processor.service';
import { CycleCompletionService } from './cycle-completion.service';
import { InjectRepository } from '@nestjs/typeorm';
import { ArbitrageCycle } from '../db/entities/arbitrage-cycle.entity';
import { In, Not, Repository } from 'typeorm';
import { ArbitrageRecordService } from '../db/arbitrage-record.service';

@Injectable()
export class ArbitrageFlowManagerService implements OnModuleInit {
  private readonly logger = new Logger(ArbitrageFlowManagerService.name);

  private readonly profitThresholdPercent: number;
  private readonly TARGET_OVERALL_CYCLE_PROFIT_PERCENT: number;
  private readonly DECISION_WINDOW_MS = 2000; // 2초의 결정 시간

  constructor(
    private readonly configService: ConfigService,
    private readonly cycleStateService: ArbitrageCycleStateService,
    private readonly priceFeedService: PriceFeedService,
    private readonly spreadCalculatorService: SpreadCalculatorService,
    private readonly highPremiumProcessorService: HighPremiumProcessorService,
    private readonly lowPremiumProcessorService: LowPremiumProcessorService,
    private readonly cycleCompletionService: CycleCompletionService,
    private readonly arbitrageRecordService: ArbitrageRecordService,
    @InjectRepository(ArbitrageCycle)
    private readonly arbitrageCycleRepository: Repository<ArbitrageCycle>,
  ) {
    this.profitThresholdPercent =
      this.configService.get<number>('PROFIT_THRESHOLD_PERCENT') || 0.7;
    this.TARGET_OVERALL_CYCLE_PROFIT_PERCENT =
      this.configService.get<number>('TARGET_OVERALL_CYCLE_PROFIT_PERCENT') ||
      0.1;
  }

  async onModuleInit() {
    this.logger.log(
      'Initializing Flow Manager, checking for incomplete cycles...',
    );
    const incompleteCycles = await this.arbitrageCycleRepository.find({
      where: {
        status: Not(
          In([
            'COMPLETED',
            'FAILED',
            'HIGH_PREMIUM_ONLY_COMPLETED_TARGET_MISSED',
          ]),
        ),
      },
    });

    if (incompleteCycles.length > 0) {
      this.logger.warn(
        `Found ${incompleteCycles.length} incomplete cycle(s). Attempting to recover...`,
      );
      for (const cycle of incompleteCycles) {
        await this.recoverCycle(cycle);
      }
    }
  }

  private async recoverCycle(cycle: ArbitrageCycle) {
    this.logger.log(`Recovering cycle ${cycle.id} with status ${cycle.status}`);

    // [수정된 부분] 복구 가능한 상태에서 'HIGH_PREMIUM_COMPLETED'를 제거
    if (cycle.status === 'AWAITING_LP' || cycle.status === 'HP_SOLD') {
      const initialInvestmentKrw = Number(cycle.initialInvestmentKrw);
      const highPremiumNetProfitKrw = Number(cycle.highPremiumNetProfitKrw);
      const initialRate = Number(cycle.highPremiumInitialRate);

      if (
        isNaN(initialInvestmentKrw) ||
        isNaN(highPremiumNetProfitKrw) ||
        isNaN(initialRate)
      ) {
        this.logger.error(
          `[RECOVERY_FAIL] Cycle ${cycle.id} has invalid numeric data. Marking as FAILED.`,
        );
        await this.arbitrageRecordService.updateArbitrageCycle(cycle.id, {
          status: 'FAILED',
          errorDetails:
            'Failed during recovery: cycle data contains invalid numbers.',
        });
        return;
      }

      const overallTargetProfitKrw =
        (initialInvestmentKrw * this.TARGET_OVERALL_CYCLE_PROFIT_PERCENT) / 100;
      const requiredProfit = overallTargetProfitKrw - highPremiumNetProfitKrw;

      this.cycleStateService.completeHighPremiumAndAwaitLowPremium(
        requiredProfit,
        initialRate,
      );

      // 'as any'를 사용하여 private 속성에 접근하는 대신, 상태 서비스에 public 메소드를 만드는 것이 더 좋지만,
      // 현재 구조를 유지하기 위해 이 방법을 사용합니다.
      (this.cycleStateService as any)._activeCycleId = cycle.id;

      this.logger.log(
        `✅ Cycle ${cycle.id} state recovered to AWAITING_LOW_PREMIUM. Required profit: ${requiredProfit.toFixed(0)} KRW.`,
      );
    } else {
      this.logger.error(
        `Cannot automatically recover cycle ${cycle.id} from status ${cycle.status}. Marking as FAILED.`,
      );
      await this.arbitrageRecordService.updateArbitrageCycle(cycle.id, {
        status: 'FAILED',
        errorDetails: `Failed during recovery process from unexpected state: ${cycle.status}`,
      });
    }
  }

  public async handlePriceUpdate(symbol: string): Promise<void> {
    const currentState = this.cycleStateService.currentCycleExecutionStatus;

    if (this.configService.get<string>('TRADING_ENABLED') === 'false') {
      // this.logger.verbose('Trading is disabled via configuration.'); // 필요시 로그 활성화
      return;
    }

    if (this.cycleStateService.hasReachedMaxCycles()) {
      if (currentState !== CycleExecutionStatus.STOPPED) {
        this.logger.warn(
          `[FlowManager] 최대 사이클 횟수에 도달하여 더 이상 새로운 거래를 시작하지 않습니다.`,
        );
        // 상태 서비스 내부에서 상태를 STOPPED로 변경하므로 여기선 추가 작업 불필요
      }
      return;
    }

    // IDLE 또는 DECISION_WINDOW_ACTIVE 상태일 때만 고프리미엄 기회 탐색
    if (
      currentState === CycleExecutionStatus.IDLE ||
      currentState === CycleExecutionStatus.DECISION_WINDOW_ACTIVE
    ) {
      const upbitPrice = this.priceFeedService.getUpbitPrice(symbol);
      const binancePrice = this.priceFeedService.getBinancePrice(symbol);
      if (upbitPrice === undefined || binancePrice === undefined) return;

      // 1. 순수익률 계산
      const opportunity = await this.spreadCalculatorService.calculateSpread({
        symbol,
        upbitPrice,
        binancePrice,
        profitThresholdPercent: this.profitThresholdPercent,
      });

      // 2. 수익 기회가 있는 경우
      if (opportunity) {
        // 3. 이미 결정 시간이 활성화된 경우
        if (currentState === CycleExecutionStatus.DECISION_WINDOW_ACTIVE) {
          const currentBest = this.cycleStateService.getBestOpportunity();
          // 새로 찾은 기회가 기존 최고 후보보다 좋으면 교체
          if (
            currentBest &&
            opportunity.netProfitPercent > currentBest.netProfitPercent
          ) {
            this.cycleStateService.setBestOpportunity(opportunity);
          }
        }
        // 4. IDLE 상태에서 처음으로 기회를 찾은 경우
        else if (currentState === CycleExecutionStatus.IDLE) {
          // 최고 후보로 설정하고 결정 시간 타이머 시작
          this.cycleStateService.setBestOpportunity(opportunity);
          this.cycleStateService.startDecisionWindow(async () => {
            // 타이머 종료 후 실행될 로직
            const finalOpportunity =
              this.cycleStateService.getBestOpportunity();
            if (!finalOpportunity) {
              this.logger.error(
                '[DECISION] Final opportunity was null. Resetting.',
              );
              this.cycleStateService.resetCycleState();
              return;
            }

            // HighPremiumProcessor 호출
            const hpResult =
              await this.highPremiumProcessorService.processHighPremiumOpportunity(
                finalOpportunity,
              );

            // 결과 처리
            if (
              hpResult.success &&
              hpResult.nextStep === 'awaitLowPremium' &&
              hpResult.cycleId
            ) {
              this.logger.log(
                `High premium processing successful (Cycle: ${hpResult.cycleId}). Awaiting low premium processing.`,
              );
              // processLowPremium은 다음 가격 업데이트 시 자동으로 호출됨
            } else if (!hpResult.success) {
              this.logger.error(
                `High premium failed after decision. Triggering completion if cycleId exists.`,
              );
              if (hpResult.cycleId) {
                await this.cycleCompletionService.completeCycle(
                  hpResult.cycleId,
                );
              } else {
                this.cycleStateService.resetCycleState(); // Cycle ID도 없으면 그냥 리셋
              }
            }
          }, this.DECISION_WINDOW_MS);
        }
      }
    }
    // 저프리미엄 탐색 로직은 그대로 유지
    else if (currentState === CycleExecutionStatus.AWAITING_LOW_PREMIUM) {
      await this.processLowPremium();
    }
  }

  private async processLowPremium(): Promise<void> {
    if (
      this.cycleStateService.currentCycleExecutionStatus !==
      CycleExecutionStatus.AWAITING_LOW_PREMIUM
    ) {
      // this.logger.verbose(
      //   `[FM_ProcessLowPremium] Not in AWAITING_LOW_PREMIUM state, skipping. Current: ${CycleExecutionStatus[this.cycleStateService.currentCycleExecutionStatus]}`,
      // );
      return;
    }

    const result: LowPremiumResult | null =
      await this.lowPremiumProcessorService.processLowPremiumOpportunity();

    if (result && result.cycleId) {
      this.logger.log(
        `Low premium processing attempt finished for cycle ${result.cycleId}. Success: ${result.success}. Triggering completion.`,
      );
      await this.cycleCompletionService.completeCycle(result.cycleId);
    } else {
      // this.logger.verbose(
      //   `[FM_ProcessLowPremium] LowPremiumProcessor did not yield an actionable result or cycleId this time.`,
      // );
    }
  }
}
