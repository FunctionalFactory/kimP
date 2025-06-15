// src/arbitrage/cycle-completion.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ArbitrageCycleStateService } from './arbitrage-cycle-state.service';
import { PortfolioLogService } from '../db/portfolio-log.service';
import { ArbitrageRecordService } from '../db/arbitrage-record.service';
import { NotificationComposerService } from '../notification/notification-composer.service';
import { ArbitrageCycle } from '../db/entities/arbitrage-cycle.entity';
import { PortfolioLog } from '../db/entities/portfolio-log.entity';

@Injectable()
export class CycleCompletionService {
  private readonly logger = new Logger(CycleCompletionService.name);
  private readonly INITIAL_CAPITAL_KRW: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly cycleStateService: ArbitrageCycleStateService,
    private readonly portfolioLogService: PortfolioLogService,
    private readonly arbitrageRecordService: ArbitrageRecordService,
    private readonly notificationComposerService: NotificationComposerService,
  ) {
    this.INITIAL_CAPITAL_KRW =
      this.configService.get<number>('INITIAL_CAPITAL_KRW') || 1500000;
  }

  private parseAndValidateNumber(value: any): number | null {
    if (value === null || value === undefined) return null;
    const num = Number(value);
    return isNaN(num) ? null : num;
  }

  public async completeCycle(cycleId: string): Promise<void> {
    this.logger.log(`Attempting to complete cycle: ${cycleId}`);

    const previousPortfolioLog =
      this.cycleStateService.latestPortfolioLogAtCycleStart;
    let finalCycleData =
      await this.arbitrageRecordService.getArbitrageCycle(cycleId);

    if (!finalCycleData) {
      this.logger.error(
        `[CycleCompletion] Critical: Cycle data for ${cycleId} not found in DB. Attempting to log with minimal info.`,
      );
      finalCycleData = {
        id: cycleId,
        status: 'FAILED_DB_RECORD_NOT_FOUND',
        totalNetProfitKrw: 0,
        totalNetProfitPercent: 0,
        errorDetails: 'Cycle record not found in database during completion.',
        startTime: new Date(),
        initialInvestmentKrw: previousPortfolioLog
          ? this.parseAndValidateNumber(previousPortfolioLog.total_balance_krw)
          : this.INITIAL_CAPITAL_KRW,
      } as unknown as ArbitrageCycle;
    }

    await this.finalizeCycleAndLogPortfolio(
      cycleId,
      finalCycleData,
      previousPortfolioLog,
    );
    await this.notificationComposerService.composeAndSendNotifications(
      cycleId,
      finalCycleData,
    );

    this.cycleStateService.incrementCompletedCycleCount();

    this.cycleStateService.resetCycleState();
    this.logger.log(
      `Cycle ${cycleId} has been completed and state reset by CycleCompletionService.`,
    );
  }

  private async finalizeCycleAndLogPortfolio(
    cycleId: string,
    finalCycleData: ArbitrageCycle,
    previousPortfolioLog: PortfolioLog | null,
  ): Promise<PortfolioLog> {
    const previousTotalBalanceKrw = previousPortfolioLog?.total_balance_krw
      ? this.parseAndValidateNumber(previousPortfolioLog.total_balance_krw) ||
        this.INITIAL_CAPITAL_KRW
      : this.INITIAL_CAPITAL_KRW;

    const currentCyclePnlKrw =
      this.parseAndValidateNumber(finalCycleData.totalNetProfitKrw) || 0;
    const newTotalBalanceKrw = previousTotalBalanceKrw + currentCyclePnlKrw;

    const upbitBalanceForLog = newTotalBalanceKrw;
    const binanceBalanceForLog = 0;

    const newLog = await this.portfolioLogService.createLog({
      timestamp: new Date(),
      upbit_balance_krw: upbitBalanceForLog,
      binance_balance_krw: binanceBalanceForLog,
      total_balance_krw: newTotalBalanceKrw,
      cycle_pnl_krw: currentCyclePnlKrw,
      cycle_pnl_rate_percent:
        this.parseAndValidateNumber(finalCycleData.totalNetProfitPercent) || 0,
      linked_arbitrage_cycle_id: cycleId,
      remarks: `사이클 ${cycleId} (${finalCycleData.status || 'N/A'}) 완료. 이전 총액: ${previousTotalBalanceKrw.toFixed(0)}, PNL: ${currentCyclePnlKrw.toFixed(0)}, 새 총액: ${newTotalBalanceKrw.toFixed(0)} (CCS)`,
    });
    this.logger.log(
      `[PortfolioLog CCS] 새 로그 기록 완료. 새 총 자본금: ${newTotalBalanceKrw.toFixed(0)} KRW. Log ID: ${newLog.id}`,
    );
    return newLog;
  }
}
