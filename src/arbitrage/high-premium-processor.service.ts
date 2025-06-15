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
import { ExchangeService } from 'src/common/exchange.service';

export interface HighPremiumConditionData {
  symbol: string;
  upbitPrice: number;
  binancePrice: number;
  rate: number;
  netProfit: number;
  netProfitPercent: number;
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
    private readonly arbitrageService: ArbitrageService,
    private readonly exchangeService: ExchangeService,
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
      const mode = this.configService.get('BINANCE_MODE');
      this.logger.warn(
        `No portfolio log found. Initializing portfolio in ${mode || 'REAL'} mode...`,
      );

      if (mode === 'SIMULATION') {
        // --- 시뮬레이션 모드 로직 ---
        currentTotalKRWCapital = this.INITIAL_CAPITAL_KRW;
        this.logger.log(
          `[SIMULATION] Starting with configured initial capital: ${currentTotalKRWCapital.toFixed(0)} KRW`,
        );

        latestPortfolioLog = await this.portfolioLogService.createLog({
          timestamp: new Date(),
          upbit_balance_krw: 0,
          binance_balance_krw: currentTotalKRWCapital, // 시뮬레이션에서도 바이낸스에 자본이 있는 것으로 가정
          total_balance_krw: currentTotalKRWCapital,
          cycle_pnl_krw: 0,
          cycle_pnl_rate_percent: 0,
          remarks:
            'System Start: Initial portfolio log created for SIMULATION mode.',
        });
      } else {
        // --- 실전 모드 로직 ---
        const binanceBalances =
          await this.exchangeService.getBalances('binance');
        const usdtBalance =
          binanceBalances.find((b) => b.currency === 'USDT')?.available || 0;

        const rate = this.exchangeService.getUSDTtoKRW();
        if (usdtBalance <= 0 || rate <= 0) {
          throw new Error(
            `Cannot initialize portfolio for REAL mode. Binance USDT balance is ${usdtBalance} or rate is ${rate}.`,
          );
        }

        const initialBinanceKrw = usdtBalance * rate;
        currentTotalKRWCapital = initialBinanceKrw;

        this.logger.log(
          `[REAL] Initial portfolio value calculated: ${currentTotalKRWCapital.toFixed(
            0,
          )} KRW (from ${usdtBalance.toFixed(2)} USDT)`,
        );
        latestPortfolioLog = await this.portfolioLogService.createLog({
          timestamp: new Date(),
          upbit_balance_krw: 0,
          binance_balance_krw: currentTotalKRWCapital,
          total_balance_krw: currentTotalKRWCapital,
          cycle_pnl_krw: 0,
          cycle_pnl_rate_percent: 0,
          remarks:
            'System Start: Initial portfolio log created from REAL Binance balance.',
        });
      }
    }

    if (currentTotalKRWCapital <= 0) {
      this.logger.error(
        `Total capital is ${currentTotalKRWCapital.toFixed(0)} KRW. Cannot start arbitrage.`,
      );
      return { success: false, nextStep: 'failed' };
    }
    const strategy = this.configService.get<string>('INVESTMENT_STRATEGY');
    const percentage = this.configService.get<number>('INVESTMENT_PERCENTAGE');
    let highPremiumInvestmentKRW: number;

    if (strategy === 'PERCENTAGE' && percentage > 0 && percentage <= 100) {
      highPremiumInvestmentKRW = currentTotalKRWCapital * (percentage / 100);
      this.logger.log(
        `[INVESTMENT] PERCENTAGE(${percentage}%) 전략 적용. 투자금: ${highPremiumInvestmentKRW.toFixed(0)} KRW`,
      );
    } else {
      highPremiumInvestmentKRW = currentTotalKRWCapital;
      this.logger.log(
        `[INVESTMENT] FULL_CAPITAL 전략 적용. 투자금: ${highPremiumInvestmentKRW.toFixed(0)} KRW`,
      );
    }

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
          // status는 createArbitrageCycle 내부에서 'STARTED'로 설정되므로 여기서 제거
        });

      this.cycleStateService.startHighPremiumProcessing(
        tempCycleIdRecord.id,
        latestPortfolioLog,
      );

      this.logger.warn(
        `✨ [HIGH_PREMIUM_START] ${data.symbol.toUpperCase()} ... 총 자본 ${highPremiumInvestmentKRW.toFixed(0)} KRW로 사이클 시작! (ID: ${this.cycleStateService.activeCycleId})`,
      );

      const randomSeconds = Math.floor(Math.random() * (60 - 60 + 1)) + 60;
      this.logger.log(
        `➡️ [SIMULATE] 고프리미엄 ${data.symbol.toUpperCase()} 매수 및 송금 시작 (${(randomSeconds / 60).toFixed(1)}분 대기)`,
      );
      await new Promise((resolve) => setTimeout(resolve, randomSeconds * 1000));

      // [수정된 부분] 새로운 객체를 만드는 대신, 필요한 모든 정보가 담긴 'data'를 그대로 전달합니다.
      await this.arbitrageService.simulateArbitrage(
        data,
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
        highPremiumCompletedCycle.status !== 'HP_SOLD'
      ) {
        throw new Error(
          `고프리미엄 단계 (${this.cycleStateService.activeCycleId})가 DB에서 HP_SOLD 상태로 확인되지 않았습니다. Status: ${highPremiumCompletedCycle?.status}`,
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

      await this.arbitrageRecordService.updateArbitrageCycle(
        this.cycleStateService.activeCycleId!,
        { status: 'AWAITING_LP' },
      );

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
      }

      return { success: false, nextStep: 'failed', cycleId: cycleIdToLog };
    }
  }
}
