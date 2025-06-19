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
import { PortfolioLogService } from 'src/db/portfolio-log.service'; // ⭐️ Import 추가
import { ExchangeService } from 'src/common/exchange.service';

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
    private readonly portfolioLogService: PortfolioLogService, // ⭐️ 주입 추가
    private readonly exchangeService: ExchangeService, // ⭐️ 1. exchangeService 주입 추가
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

      // --- 1. 잠재적 투자금액 결정 ---
      // 실제 거래에서는 더 정교한 방법으로 투자금을 결정해야 합니다.
      // 여기서는 최신 포트폴리오의 10%를 투자한다고 가정합니다.
      const latestPortfolio =
        await this.portfolioLogService.getLatestPortfolio();
      const totalCapitalKRW =
        latestPortfolio?.total_balance_krw ||
        this.configService.get<number>('INITIAL_CAPITAL_KRW');
      const investmentKRW = Number(totalCapitalKRW) * 0.1;
      const rate = this.exchangeService.getUSDTtoKRW();
      if (rate === 0) {
        this.logger.warn('Rate is 0, skipping opportunity check.');
        return;
      }
      const investmentUSDT = investmentKRW / rate;

      // --- 2. '전문가'에게 검증된 기회인지 문의 ---
      // 이제 calculateSpread는 가격, 거래량, 슬리피지 필터를 모두 통과한 '진짜 기회'만 반환합니다.
      const opportunity = await this.spreadCalculatorService.calculateSpread({
        symbol,
        upbitPrice,
        binancePrice,
        investmentUSDT,
      });

      // --- 3. 검증된 기회에 대해서만 의사결정 진행 ---
      if (opportunity) {
        // 3. 상태에 따라 다르게 행동
        if (currentState === CycleExecutionStatus.IDLE) {
          // IDLE 상태에서 처음으로 '진짜' 기회를 찾았으므로 결정 시간 타이머 시작
          this.cycleStateService.setBestOpportunity(opportunity);
          this.cycleStateService.startDecisionWindow(async () => {
            const finalOpportunity =
              this.cycleStateService.getBestOpportunity();
            if (!finalOpportunity) {
              this.logger.error(
                '[DECISION] Final opportunity was null. Resetting.',
              );
              this.cycleStateService.resetCycleState();
              return;
            }

            const hpResult =
              await this.highPremiumProcessorService.processHighPremiumOpportunity(
                finalOpportunity,
              );

            if (
              hpResult.success &&
              hpResult.nextStep === 'awaitLowPremium' &&
              hpResult.cycleId
            ) {
              this.logger.log(
                `High premium processing successful (Cycle: ${hpResult.cycleId}). Awaiting low premium processing.`,
              );
            } else if (!hpResult.success) {
              // ⭐️ 2. 오류 로그 수정
              this.logger.error(
                `High premium processing failed. Triggering completion if cycleId exists.`,
              );
              if (hpResult.cycleId) {
                await this.cycleCompletionService.completeCycle(
                  hpResult.cycleId,
                );
              } else {
                this.cycleStateService.resetCycleState();
              }
            }
          }, this.DECISION_WINDOW_MS);
        } else if (
          currentState === CycleExecutionStatus.DECISION_WINDOW_ACTIVE
        ) {
          // 이미 결정 시간이 활성화된 경우, 더 좋은 기회로 후보를 교체
          const currentBest = this.cycleStateService.getBestOpportunity();
          if (
            !currentBest ||
            opportunity.netProfitPercent > currentBest.netProfitPercent
          ) {
            this.cycleStateService.setBestOpportunity(opportunity);
          }
        }
      }
    } else if (currentState === CycleExecutionStatus.AWAITING_LOW_PREMIUM) {
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
