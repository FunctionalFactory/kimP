// src/arbitrage/arbitrage-flow-manager.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config'; // profitThresholdPercent만 여기서 사용
import {
  ArbitrageCycleStateService,
  CycleExecutionStatus,
} from './arbitrage-cycle-state.service';
import { PriceFeedService } from '../marketdata/price-feed.service';
import { SpreadCalculatorService } from '../common/spread-calculator.service';
// PortfolioLogService는 CycleCompletionService가 사용
import { ArbitrageRecordService } from '../db/arbitrage-record.service'; // CycleCompletionService가 사용
// ExchangeService는 각 Processor가 사용
// ArbitrageCycle, PortfolioLog 엔티티 타입은 각 서비스에서 필요시 임포트
import {
  HighPremiumProcessorService,
  HighPremiumConditionData,
} from './high-premium-processor.service';
import {
  LowPremiumProcessorService,
  LowPremiumResult,
} from './low-premium-processor.service';
// NotificationComposerService는 CycleCompletionService가 사용
import { CycleCompletionService } from './cycle-completion.service';

@Injectable()
export class ArbitrageFlowManagerService {
  private readonly logger = new Logger(ArbitrageFlowManagerService.name);

  private readonly profitThresholdPercent: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly cycleStateService: ArbitrageCycleStateService,
    private readonly priceFeedService: PriceFeedService,
    private readonly spreadCalculatorService: SpreadCalculatorService,
    // private readonly arbitrageRecordService: ArbitrageRecordService, // CycleCompletionService로 이동
    private readonly highPremiumProcessorService: HighPremiumProcessorService,
    private readonly lowPremiumProcessorService: LowPremiumProcessorService,
    private readonly cycleCompletionService: CycleCompletionService,
  ) {
    this.profitThresholdPercent =
      this.configService.get<number>('PROFIT_THRESHOLD_PERCENT') || 0.7;
  }

  // parseAndValidateNumber는 각 서비스가 필요시 자체적으로 가짐

  public async handlePriceUpdate(symbol: string): Promise<void> {
    if (
      this.cycleStateService.currentCycleExecutionStatus ===
      CycleExecutionStatus.IDLE
    ) {
      const upbitPrice = this.priceFeedService.getUpbitPrice(symbol);
      const binancePrice = this.priceFeedService.getBinancePrice(symbol);

      if (upbitPrice === undefined || binancePrice === undefined) {
        return;
      }

      await this.spreadCalculatorService.calculateSpread({
        symbol,
        upbitPrice,
        binancePrice,
        profitThresholdPercent: this.profitThresholdPercent,
        onArbitrageConditionMet: async (data: HighPremiumConditionData) => {
          const hpResult =
            await this.highPremiumProcessorService.processHighPremiumOpportunity(
              data,
            );

          if (
            hpResult.success &&
            hpResult.nextStep === 'awaitLowPremium' &&
            hpResult.cycleId
          ) {
            this.logger.log(
              `High premium processing successful (Cycle: ${hpResult.cycleId}). Triggering low premium processing.`,
            );
            await this.processLowPremium();
          } else if (!hpResult.success && hpResult.cycleId) {
            this.logger.error(
              `High premium failed (Cycle: ${hpResult.cycleId}). Triggering completion.`,
            );
            await this.cycleCompletionService.completeCycle(hpResult.cycleId);
          } else if (!hpResult.success && !hpResult.cycleId) {
            this.logger.error(
              'High premium processing failed before cycle ID generation or an unknown error occurred.',
            );
            // 이 경우엔 IDLE 상태이므로 resetCycleState() 불필요
          }
        },
      });
    } else if (
      this.cycleStateService.currentCycleExecutionStatus ===
      CycleExecutionStatus.AWAITING_LOW_PREMIUM
    ) {
      await this.processLowPremium();
    }
  }

  private async processLowPremium(): Promise<void> {
    if (
      this.cycleStateService.currentCycleExecutionStatus !==
      CycleExecutionStatus.AWAITING_LOW_PREMIUM
    ) {
      this.logger.verbose(
        `[FM_ProcessLowPremium] Not in AWAITING_LOW_PREMIUM state, skipping. Current: ${CycleExecutionStatus[this.cycleStateService.currentCycleExecutionStatus]}`,
      );
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
      this.logger.verbose(
        `[FM_ProcessLowPremium] LowPremiumProcessor did not yield an actionable result or cycleId this time.`,
      );
      // 기회가 없거나 조건 미충족으로 LPP가 null을 반환한 경우, FlowManager는 아무것도 하지 않고 다음 가격 업데이트를 기다림.
      // 상태 리셋은 LPP가 타임아웃 등의 이유로 명시적인 실패 결과를 반환하고, 그 결과를 받아 completeCycle이 호출될 때 이루어짐.
    }
  }
}
