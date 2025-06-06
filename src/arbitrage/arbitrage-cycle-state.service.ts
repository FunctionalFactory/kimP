// src/arbitrage/arbitrage-cycle-state.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PortfolioLog } from '../db/entities/portfolio-log.entity'; // PortfolioLog 타입 임포트
import { HighPremiumConditionData } from './high-premium-processor.service';

// WsService에서 가져온 CycleExecutionStatus enum
export enum CycleExecutionStatus {
  IDLE,
  DECISION_WINDOW_ACTIVE,
  HIGH_PREMIUM_PROCESSING,
  AWAITING_LOW_PREMIUM,
  LOW_PREMIUM_PROCESSING,
}

@Injectable()
export class ArbitrageCycleStateService {
  private readonly logger = new Logger(ArbitrageCycleStateService.name);

  private _currentCycleExecutionStatus: CycleExecutionStatus =
    CycleExecutionStatus.IDLE;
  private _activeCycleId: string | null = null;
  private _requiredLowPremiumNetProfitKrwForActiveCycle: number | null = null;
  private _highPremiumInitialRateForActiveCycle: number | null = null;
  private _lowPremiumSearchStartTime: number | null = null;
  private _latestPortfolioLogAtCycleStart: PortfolioLog | null = null;
  private _bestOpportunityCandidate: HighPremiumConditionData | null = null;
  private _decisionTimer: NodeJS.Timeout | null = null;

  // Getters
  get currentCycleExecutionStatus(): CycleExecutionStatus {
    return this._currentCycleExecutionStatus;
  }
  get activeCycleId(): string | null {
    return this._activeCycleId;
  }
  get requiredLowPremiumNetProfitKrwForActiveCycle(): number | null {
    return this._requiredLowPremiumNetProfitKrwForActiveCycle;
  }
  get highPremiumInitialRateForActiveCycle(): number | null {
    return this._highPremiumInitialRateForActiveCycle;
  }
  get lowPremiumSearchStartTime(): number | null {
    return this._lowPremiumSearchStartTime;
  }
  get latestPortfolioLogAtCycleStart(): PortfolioLog | null {
    return this._latestPortfolioLogAtCycleStart;
  }

  public getBestOpportunity(): HighPremiumConditionData | null {
    return this._bestOpportunityCandidate;
  }
  public setBestOpportunity(opportunity: HighPremiumConditionData): void {
    this._bestOpportunityCandidate = opportunity;
    this.logger.log(
      `[DECISION] New best opportunity: ${opportunity.symbol.toUpperCase()} (${opportunity.netProfitPercent.toFixed(2)}%)`,
    );
  }

  public startDecisionWindow(onComplete: () => void, delayMs: number): void {
    if (this._decisionTimer) return; // 이미 타이머가 활성화되어 있으면 중복 실행 방지

    this.logger.log(`[DECISION] Starting ${delayMs}ms decision window.`);
    this._currentCycleExecutionStatus =
      CycleExecutionStatus.DECISION_WINDOW_ACTIVE;

    this._decisionTimer = setTimeout(() => {
      this.logger.log(
        '[DECISION] Decision window closed. Executing best opportunity.',
      );
      onComplete(); // 타이머 종료 후 콜백 함수 실행
      this.clearDecisionWindow(); // 상태 정리
    }, delayMs);
  }

  public clearDecisionWindow(): void {
    if (this._decisionTimer) {
      clearTimeout(this._decisionTimer);
      this._decisionTimer = null;
    }
    this._bestOpportunityCandidate = null;
    // 상태를 IDLE로 되돌리는 것은 FlowManager가 최종 결정
  }

  // Setters / State Transition Methods
  public startHighPremiumProcessing(
    activeCycleId: string,
    latestPortfolioLog: PortfolioLog | null,
  ): void {
    this._currentCycleExecutionStatus =
      CycleExecutionStatus.HIGH_PREMIUM_PROCESSING;
    this._activeCycleId = activeCycleId;
    this._latestPortfolioLogAtCycleStart = latestPortfolioLog;
    this.logger.log(
      `State changed to HIGH_PREMIUM_PROCESSING. Cycle ID: ${activeCycleId}`,
    );
  }

  public completeHighPremiumAndAwaitLowPremium(
    requiredLowPremiumNetProfit: number,
    initialRate: number,
  ): void {
    if (
      this._currentCycleExecutionStatus !==
      CycleExecutionStatus.HIGH_PREMIUM_PROCESSING
    ) {
      this.logger.warn(
        'Cannot complete high premium: Not in HIGH_PREMIUM_PROCESSING state.',
      );
      return;
    }
    this._requiredLowPremiumNetProfitKrwForActiveCycle =
      requiredLowPremiumNetProfit;
    this._highPremiumInitialRateForActiveCycle = initialRate;
    this._currentCycleExecutionStatus =
      CycleExecutionStatus.AWAITING_LOW_PREMIUM;
    this._lowPremiumSearchStartTime = Date.now();
    this.logger.log(
      `State changed to AWAITING_LOW_PREMIUM. Required Low Premium Profit: ${requiredLowPremiumNetProfit}`,
    );
  }

  public startLowPremiumProcessing(): boolean {
    if (
      this._currentCycleExecutionStatus !==
      CycleExecutionStatus.AWAITING_LOW_PREMIUM
    ) {
      this.logger.warn(
        'Cannot start low premium: Not in AWAITING_LOW_PREMIUM state.',
      );
      return false; // Indicate failure if not in correct state
    }
    this._currentCycleExecutionStatus =
      CycleExecutionStatus.LOW_PREMIUM_PROCESSING;
    this.logger.log(
      `State changed to LOW_PREMIUM_PROCESSING. Cycle ID: ${this._activeCycleId}`,
    );
    return true; // Indicate success
  }

  public resetCycleState(): void {
    this.logger.log(
      `Resetting cycle state. Previous Cycle ID: ${this._activeCycleId || 'N/A'}`,
    );
    this.clearDecisionWindow();
    this._currentCycleExecutionStatus = CycleExecutionStatus.IDLE;
    this._activeCycleId = null;
    this._requiredLowPremiumNetProfitKrwForActiveCycle = null;
    this._highPremiumInitialRateForActiveCycle = null;
    this._lowPremiumSearchStartTime = null;
    this._latestPortfolioLogAtCycleStart = null; // Reset for the next cycle
  }
}
