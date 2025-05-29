// src/notification/notification-composer.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ArbitrageCycle } from '../db/entities/arbitrage-cycle.entity';
import { PortfolioLog } from '../db/entities/portfolio-log.entity'; // 최신 잔고 표시 위해 필요
import { PortfolioLogService } from '../db/portfolio-log.service';
import { TelegramService } from '../common/telegram.service';

@Injectable()
export class NotificationComposerService {
  private readonly logger = new Logger(NotificationComposerService.name);
  private readonly INITIAL_CAPITAL_KRW: number; // sendTelegramSummary에서 total capital deployed 계산 시 필요할 수 있음

  constructor(
    private readonly telegramService: TelegramService,
    private readonly portfolioLogService: PortfolioLogService, // 최신 잔고 조회를 위해
    private readonly configService: ConfigService,
  ) {
    this.INITIAL_CAPITAL_KRW =
      this.configService.get<number>('INITIAL_CAPITAL_KRW') || 1500000;
  }

  private parseAndValidateNumber(value: any): number | null {
    if (value === null || value === undefined) return null;
    const num = Number(value);
    return isNaN(num) ? null : num;
  }

  public async composeAndSendNotifications(
    cycleId: string,
    cycleData: ArbitrageCycle | null,
    // previousPortfolioLog: PortfolioLog | null, // 필요시 이전 포트폴리오 정보도 받을 수 있음
    // newTotalBalanceKrw?: number // CycleOrchestrator가 계산한 값을 직접 받을 수도 있음
  ): Promise<void> {
    if (!cycleData) {
      this.logger.error(
        `[NotificationComposer] Cycle data for ${cycleId} not found. Cannot compose summary.`,
      );
      await this.telegramService.sendMessage(
        `⚠️ *[시스템 오류]* 차익거래 사이클 ID ${cycleId}의 데이터를 찾을 수 없어 요약을 생성할 수 없습니다.`,
      );
      return;
    }

    // 텔레그램 메시지 및 상세 로그를 위한 데이터 파싱 (기존 sendTelegramSummary 로직)
    const status = cycleData.status;
    const highSymbol = cycleData.highPremiumSymbol?.toUpperCase() || 'N/A';
    const lowSymbol = cycleData.lowPremiumSymbol?.toUpperCase() || 'N/A';
    const initialInvestmentKrwNum = this.parseAndValidateNumber(
      cycleData.initialInvestmentKrw,
    );
    const initialInvestmentUsdNum = this.parseAndValidateNumber(
      cycleData.initialInvestmentUsd,
    ); // 로그용
    const highPremiumNetProfitKrwNum = this.parseAndValidateNumber(
      cycleData.highPremiumNetProfitKrw,
    );
    const highPremiumNetProfitUsdNum = this.parseAndValidateNumber(
      cycleData.highPremiumNetProfitUsd,
    ); // 로그용
    const lowPremiumNetProfitKrwNum = this.parseAndValidateNumber(
      cycleData.lowPremiumNetProfitKrw,
    );
    const lowPremiumNetProfitUsdNum = this.parseAndValidateNumber(
      cycleData.lowPremiumNetProfitUsd,
    ); // 로그용
    const totalNetProfitKrwNum = this.parseAndValidateNumber(
      cycleData.totalNetProfitKrw,
    );
    const totalNetProfitUsdNum = this.parseAndValidateNumber(
      cycleData.totalNetProfitUsd,
    ); // 로그용
    const totalNetProfitPercentNum = this.parseAndValidateNumber(
      cycleData.totalNetProfitPercent,
    );

    // 수수료 관련 변수 (상세 로그용)
    const hpShortEntryFeeKrw = this.parseAndValidateNumber(
      cycleData.highPremiumShortEntryFeeKrw,
    );
    const hpTransferFeeKrw = this.parseAndValidateNumber(
      cycleData.highPremiumTransferFeeKrw,
    );
    const hpSellFeeKrw = this.parseAndValidateNumber(
      cycleData.highPremiumSellFeeKrw,
    );
    const hpShortExitFeeKrw = this.parseAndValidateNumber(
      cycleData.highPremiumShortExitFeeKrw,
    );
    const highPremiumRecordedFeesKrw =
      (hpShortEntryFeeKrw || 0) +
      (hpTransferFeeKrw || 0) +
      (hpSellFeeKrw || 0) +
      (hpShortExitFeeKrw || 0);

    let lowPremiumRecordedFeesKrw = 0;
    if (
      lowSymbol !== 'N/A' &&
      (status === 'COMPLETED' || cycleData.lowPremiumNetProfitKrw !== null)
    ) {
      const lpShortEntryFeeKrw = this.parseAndValidateNumber(
        cycleData.lowPremiumShortEntryFeeKrw,
      );
      const lpTransferFeeKrw = this.parseAndValidateNumber(
        cycleData.lowPremiumTransferFeeKrw,
      );
      const lpSellFeeKrw = this.parseAndValidateNumber(
        cycleData.lowPremiumSellFeeKrw,
      );
      const lpShortExitFeeKrw = this.parseAndValidateNumber(
        cycleData.lowPremiumShortExitFeeKrw,
      );
      lowPremiumRecordedFeesKrw =
        (lpShortEntryFeeKrw || 0) +
        (lpTransferFeeKrw || 0) +
        (lpSellFeeKrw || 0) +
        (lpShortExitFeeKrw || 0);
    }

    // 사이클 완료 후의 최신 포트폴리오 잔고 조회 (PortfolioUpdateService가 업데이트한 후)
    const latestPortfolioAfterCycle =
      await this.portfolioLogService.getLatestPortfolio();
    let updatedTotalBalanceKrwStr = 'N/A';
    if (
      latestPortfolioAfterCycle &&
      latestPortfolioAfterCycle.total_balance_krw !== null
    ) {
      const updatedNum = this.parseAndValidateNumber(
        latestPortfolioAfterCycle.total_balance_krw,
      );
      if (updatedNum !== null)
        updatedTotalBalanceKrwStr = `${updatedNum.toFixed(0)} KRW`;
    }

    // 텔레그램 메시지 생성
    let telegramMessage = '';
    if (status === 'COMPLETED') {
      telegramMessage =
        `✅ *[시뮬레이션] 차익거래 사이클 ${cycleId} 완료!*\n` +
        `총 수익률: ${totalNetProfitPercentNum !== null ? totalNetProfitPercentNum.toFixed(2) : 'N/A'}%\n` +
        `총 순이익: ${totalNetProfitKrwNum !== null ? totalNetProfitKrwNum.toFixed(0) : 'N/A'}₩ (${totalNetProfitUsdNum !== null ? totalNetProfitUsdNum.toFixed(2) : 'N/A'}$)\n` + // USD 손익도 추가
        `고프리미엄(${highSymbol}): ${highPremiumNetProfitKrwNum !== null ? highPremiumNetProfitKrwNum.toFixed(0) : 'N/A'}₩\n` +
        `저프리미엄(${lowSymbol}): ${lowPremiumNetProfitKrwNum !== null ? lowPremiumNetProfitKrwNum.toFixed(0) : 'N/A'}₩\n` +
        `➡️ *최종 잔고: ${updatedTotalBalanceKrwStr}*`;
    } else if (
      status === 'FAILED' ||
      status === 'HIGH_PREMIUM_ONLY_COMPLETED_TARGET_MISSED'
    ) {
      telegramMessage =
        `⚠️ *[시뮬레이션] 차익거래 사이클 ${cycleId} ${status === 'FAILED' ? '실패' : '부분 완료 (목표 미달)'}*\n` +
        `사유: ${cycleData.errorDetails || '알 수 없는 오류'}\n` +
        `고프리미엄(${highSymbol}) 순이익: ${highPremiumNetProfitKrwNum !== null ? highPremiumNetProfitKrwNum.toFixed(0) : 'N/A'}₩\n` +
        (lowSymbol !== 'N/A' && lowPremiumNetProfitKrwNum !== null
          ? `저프리미엄(${lowSymbol}) 순이익: ${lowPremiumNetProfitKrwNum.toFixed(0)}₩\n`
          : '') +
        `최종 순이익: ${totalNetProfitKrwNum !== null ? totalNetProfitKrwNum.toFixed(0) : 'N/A'}₩ (${totalNetProfitUsdNum !== null ? totalNetProfitUsdNum.toFixed(2) : 'N/A'}$)\n` + // USD 손익도 추가
        `➡️ *현재 잔고: ${updatedTotalBalanceKrwStr}*`;
    } else {
      this.logger.warn(
        `[NotificationComposer] Cycle ${cycleId} has status ${status}, no standard summary message will be sent via Telegram.`,
      );
    }

    if (telegramMessage) {
      try {
        await this.telegramService.sendMessage(telegramMessage);
        this.logger.log(
          `[NotificationComposer] Telegram message sent for cycle ${cycleId}.`,
        );
      } catch (e) {
        this.logger.error(
          `[NotificationComposer] Failed to send Telegram message for cycle ${cycleId}: ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    // 상세 콘솔 로그 생성 및 출력
    this.logger.log(
      `[ARBITRAGE_SUMMARY] Cycle ID: ${cycleId} - Status: ${status}`,
    );
    this.logger.log(
      `  Initial Investment (High-Premium Leg): ${initialInvestmentKrwNum !== null ? initialInvestmentKrwNum.toFixed(0) : 'N/A'} KRW / ${initialInvestmentUsdNum !== null ? initialInvestmentUsdNum.toFixed(2) : 'N/A'} USD`,
    );
    // total capital deployed는 cycleData.initialInvestmentKrw를 사용하는 것이 더 정확.
    // 또는 고프/저프 투자금이 다를 경우 두 개의 initialInvestmentKrw 필드가 필요.
    // 여기서는 highPremiumInvestmentKRW가 전체 사이클 자본으로 간주됨.
    const totalCapitalDeployed =
      initialInvestmentKrwNum || this.INITIAL_CAPITAL_KRW;
    this.logger.log(
      `  Total Capital Deployed for Cycle: ${totalCapitalDeployed.toFixed(0)} KRW`,
    );

    this.logger.log(`  --- High Premium Leg (${highSymbol}) ---`);
    this.logger.log(
      `    Net Profit: ${highPremiumNetProfitKrwNum !== null ? highPremiumNetProfitKrwNum.toFixed(0) : 'N/A'} KRW / ${highPremiumNetProfitUsdNum !== null ? highPremiumNetProfitUsdNum.toFixed(2) : 'N/A'} USD`,
    );
    this.logger.log(
      `    Recorded Individual Fees Sum: ${highPremiumRecordedFeesKrw.toFixed(0)} KRW (Note: May not be total actual fee from FeeCalculatorService)`,
    );
    // (선택적) 개별 수수료 상세 로그
    this.logger.debug(
      `      - Binance Spot Buy Fee (est.): Not directly in DB, est. from FeeCalculatorService if available`,
    );
    this.logger.debug(
      `      - Transfer to Upbit Fee: ${hpTransferFeeKrw !== null ? hpTransferFeeKrw.toFixed(0) : 'N/A'} KRW`,
    );
    this.logger.debug(
      `      - Upbit Spot Sell Fee: ${hpSellFeeKrw !== null ? hpSellFeeKrw.toFixed(0) : 'N/A'} KRW`,
    );
    this.logger.debug(
      `      - Futures Entry Fee: ${hpShortEntryFeeKrw !== null ? hpShortEntryFeeKrw.toFixed(0) : 'N/A'} KRW`,
    );
    this.logger.debug(
      `      - Futures Exit Fee: ${hpShortExitFeeKrw !== null ? hpShortExitFeeKrw.toFixed(0) : 'N/A'} KRW`,
    );

    if (
      lowSymbol !== 'N/A' &&
      (status === 'COMPLETED' || cycleData.lowPremiumNetProfitKrw !== null)
    ) {
      this.logger.log(`  --- Low Premium Leg (${lowSymbol}) ---`);
      this.logger.log(
        `    Net Profit: ${lowPremiumNetProfitKrwNum !== null ? lowPremiumNetProfitKrwNum.toFixed(0) : 'N/A'} KRW / ${lowPremiumNetProfitUsdNum !== null ? lowPremiumNetProfitUsdNum.toFixed(2) : 'N/A'} USD`,
      );
      this.logger.log(
        `    Recorded Individual Fees Sum: ${lowPremiumRecordedFeesKrw.toFixed(0)} KRW (Note: May not be total actual fee)`,
      );
      // (선택적) 개별 수수료 상세 로그
      this.logger.debug(
        `      - Upbit Spot Buy Fee (est.): Not directly in DB, est. from FeeCalculatorService if available`,
      );
      this.logger.debug(
        `      - Transfer to Binance Fee: ${this.parseAndValidateNumber(cycleData.lowPremiumTransferFeeKrw)?.toFixed(0) || 'N/A'} KRW`,
      );
      this.logger.debug(
        `      - Binance Spot Sell Fee: ${this.parseAndValidateNumber(cycleData.lowPremiumSellFeeKrw)?.toFixed(0) || 'N/A'} KRW`,
      );
      this.logger.debug(
        `      - Futures Entry Fee: ${this.parseAndValidateNumber(cycleData.lowPremiumShortEntryFeeKrw)?.toFixed(0) || 'N/A'} KRW`,
      );
      this.logger.debug(
        `      - Futures Exit Fee: ${this.parseAndValidateNumber(cycleData.lowPremiumShortExitFeeKrw)?.toFixed(0) || 'N/A'} KRW`,
      );
    } else if (
      status === 'HIGH_PREMIUM_ONLY_COMPLETED_TARGET_MISSED' ||
      (status === 'FAILED' && lowSymbol === 'N/A')
    ) {
      this.logger.log(`  --- Low Premium Leg ---`);
      this.logger.log(`    Not executed or failed before execution.`);
    }

    this.logger.log(`  --- Overall Cycle Summary ---`);
    const overallRecordedFeesSum =
      highPremiumRecordedFeesKrw + lowPremiumRecordedFeesKrw;
    this.logger.log(
      `    Sum of All Recorded Individual Fees: ${overallRecordedFeesSum.toFixed(0)} KRW (Note: May not be overall total actual fees)`,
    );
    this.logger.log(
      `    Total Net Profit (from DB): ${totalNetProfitKrwNum !== null ? totalNetProfitKrwNum.toFixed(0) : 'N/A'} KRW / ${totalNetProfitUsdNum !== null ? totalNetProfitUsdNum.toFixed(2) : 'N/A'} USD`,
    );
    // Total Net Profit Percent 분모는 실제 총 투자금 기준 (고프 + 저프, 또는 단일 투자금의 2배 등 전략에 따라)
    // 여기서는 initialInvestmentKrwNum (고프 투자금)을 사용. 만약 고프/저프 분리 투자라면 다르게 계산 필요.
    const denominatorForPercentage = initialInvestmentKrwNum
      ? initialInvestmentKrwNum *
        (lowSymbol !== 'N/A' && status === 'COMPLETED' ? 2 : 1)
      : this.INITIAL_CAPITAL_KRW *
        (lowSymbol !== 'N/A' && status === 'COMPLETED' ? 2 : 1);
    if (denominatorForPercentage > 0) {
      this.logger.log(
        `    Total Net Profit Percent (from DB, based on ${denominatorForPercentage.toFixed(0)} KRW): ${totalNetProfitPercentNum !== null ? totalNetProfitPercentNum.toFixed(2) : 'N/A'}%`,
      );
    } else {
      this.logger.log(
        `    Total Net Profit Percent (from DB): ${totalNetProfitPercentNum !== null ? totalNetProfitPercentNum.toFixed(2) : 'N/A'}% (Denominator was 0)`,
      );
    }
    this.logger.log(`  --- Updated Portfolio ---`);
    this.logger.log(`    Latest Total Balance: ${updatedTotalBalanceKrwStr}`);
  }
}
