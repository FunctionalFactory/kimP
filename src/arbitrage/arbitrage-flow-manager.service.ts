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
        `[RECOVERY] 미완료된 사이클 ${incompleteCycles.length}개를 발견했습니다. 상태 복구를 시도합니다.`,
      );
      // 여러 개가 있더라도, 가장 오래된 하나만 복구 대상으로 삼는 것이 안전합니다.
      const cycleToRecover = incompleteCycles.sort(
        (a, b) =>
          new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
      )[0];

      await this.recoverCycle(cycleToRecover);
    } else {
      this.logger.log(
        '[RECOVERY] 미완료된 사이클이 없습니다. 정상 모드로 시작합니다.',
      );
      // 미완료 사이클이 없을 때만 포트폴리오 초기화 로직 실행
      await this.initializePortfolio();
    }
  }

  private async initializePortfolio() {
    this.logger.log(
      'ArbitrageFlowManagerService가 초기화되었습니다. 포트폴리오 상태를 확인합니다...',
    );

    this.logger.log(
      '포트폴리오 계산 전, 환율 정보를 강제로 업데이트하고 대기합니다...',
    );
    await this.exchangeService.updateRate(); // ExchangeService의 환율 업데이트가 완료될 때까지 기다립니다.
    const rate = this.exchangeService.getUSDTtoKRW();

    // 만약 환율을 여전히 가져오지 못했다면, 에러를 기록하고 더 이상 진행하지 않습니다.
    if (rate === 0) {
      this.logger.error(
        '환율 정보를 가져올 수 없어 포트폴리오 초기화를 진행할 수 없습니다.',
      );
      // 아래 미완료 사이클 복구 로직은 환율과 무관하므로 계속 실행되도록 할 수 있습니다.
      // (기존의 미완료 사이클 복구 로직은 여기에 위치)
      return;
    }
    this.logger.log(`초기화에 적용될 현재 환율: 1 USDT = ${rate} KRW`);

    // 1. 기존에 포트폴리오 로그가 있는지 확인
    const latestLog = await this.portfolioLogService.getLatestPortfolio();
    if (latestLog) {
      this.logger.log(
        `기존 포트폴리오 로그(ID: ${latestLog.id})가 존재하여, 초기화를 건너뜁니다.`,
      );
      return; // 로그가 있으면 아무것도 하지 않고 종료
    }

    // 2. 로그가 없는 경우, 최초 포트폴리오 로그를 생성
    this.logger.warn(
      '포트폴리오 로그가 없습니다. 시스템 시작을 위한 최초 포트폴리오 로그를 생성합니다.',
    );
    const mode = this.configService.get<string>('UPBIT_MODE'); // 또는 BINANCE_MODE

    let initialTotalKrw = 0;
    let upbitKrw = 0;
    let binanceKrw = 0;

    if (mode === 'REAL') {
      // 실제 모드: 업비트와 바이낸스의 모든 잔고를 조회하여 합산
      try {
        this.logger.log('[REAL MODE] 바이낸스 실제 USDT 잔고를 조회합니다...');
        const binanceBalances =
          await this.exchangeService.getBalances('binance');
        const binanceUsdtBalance =
          binanceBalances.find((b) => b.currency === 'USDT')?.available || 0;

        // 업비트 KRW 잔고도 함께 조회 (선택적)
        const upbitBalances = await this.exchangeService.getBalances('upbit');
        const upbitKrwBalance =
          upbitBalances.find((b) => b.currency === 'KRW')?.available || 0;

        upbitKrw = upbitKrwBalance;
        binanceKrw = binanceUsdtBalance * rate; // 실제 USDT 잔고를 원화로 환산
        initialTotalKrw = upbitKrw + binanceKrw;

        this.logger.log(
          `[REAL MODE] 실제 잔고 기반 총자산 계산 완료: ${initialTotalKrw.toFixed(0)} KRW`,
        );
      } catch (error) {
        this.logger.error(
          '실제 잔고 조회 중 오류가 발생하여 초기 자본금으로 대체합니다.',
          error,
        );
        initialTotalKrw =
          this.configService.get<number>('INITIAL_CAPITAL_KRW') || 0;
        binanceKrw = initialTotalKrw; // 오류 시 바이낸스에 전액 있는 것으로 가정
      }
    } else {
      // 시뮬레이션 모드: .env 파일의 초기 자본금 사용
      initialTotalKrw =
        this.configService.get<number>('INITIAL_CAPITAL_KRW') || 0;
      binanceKrw = initialTotalKrw; // 시뮬레이션 시 바이낸스에 전액 있는 것으로 가정
      this.logger.log(
        `[SIMULATION MODE] 설정된 초기 자본금: ${initialTotalKrw.toFixed(0)} KRW`,
      );
    }

    if (initialTotalKrw > 0) {
      await this.portfolioLogService.createLog({
        timestamp: new Date(),
        upbit_balance_krw: upbitKrw,
        binance_balance_krw: binanceKrw,
        total_balance_krw: initialTotalKrw,
        cycle_pnl_krw: 0,
        cycle_pnl_rate_percent: 0,
        remarks: 'System Start: Initial portfolio log created on startup.',
      });
    } else {
      this.logger.error(
        '초기 자본금이 0 이하여서 포트폴리오 로그를 생성하지 못했습니다.',
      );
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

      const allowedLossKrw = this.cycleStateService.getAllowedLowPremiumLoss();
      if (allowedLossKrw !== null) {
        this.logger.log(
          `[FM_ProcessLowPremium] 허용 가능한 저프리미엄 손실: ${allowedLossKrw.toFixed(0)} KRW`,
        );
      }
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
            const finalOpportunityCandidate =
              this.cycleStateService.getBestOpportunity();

            const finalOpportunity =
              this.cycleStateService.getBestOpportunity();
            if (!finalOpportunity) {
              this.logger.error(
                '[DECISION] Final opportunity was null. Resetting.',
              );
              this.cycleStateService.resetCycleState();
              return;
            }

            this.logger.log(
              `[FINAL_CHECK] 최종 후보 ${finalOpportunityCandidate.symbol.toUpperCase()}에 대한 마지막 실시간 검증을 시작합니다...`,
            );

            try {
              // 1. 현재 시점의 최신 가격 정보로 다시 한번 SpreadCalculatorService를 호출
              const liveUpbitPrice = this.priceFeedService.getUpbitPrice(
                finalOpportunityCandidate.symbol,
              );
              const liveBinancePrice = this.priceFeedService.getBinancePrice(
                finalOpportunityCandidate.symbol,
              );

              // 만약 그 짧은 순간에 가격 정보를 더 이상 수신할 수 없게 되면 안전하게 종료
              if (!liveUpbitPrice || !liveBinancePrice) {
                this.logger.warn(
                  `[FINAL_CHECK_FAIL] 최종 검증 실패: ${finalOpportunityCandidate.symbol}의 실시간 가격 정보가 없습니다.`,
                );
                this.cycleStateService.resetCycleState();
                return;
              }

              // 2. 포트폴리오를 다시 조회하여 최신 투자금을 계산
              const latestPortfolio =
                await this.portfolioLogService.getLatestPortfolio();
              const totalCapitalKRW =
                latestPortfolio?.total_balance_krw ||
                this.configService.get<number>('INITIAL_CAPITAL_KRW');
              const investmentKRW =
                Number(totalCapitalKRW) *
                (this.configService.get<number>('INVESTMENT_PERCENTAGE') /
                  100 || 0.1);
              const rate = this.exchangeService.getUSDTtoKRW();
              if (rate === 0) {
                this.logger.warn(
                  '[FINAL_CHECK_FAIL] 환율 정보를 사용할 수 없어 최종 검증을 건너뜁니다.',
                );
                this.cycleStateService.resetCycleState();
                return;
              }
              const investmentUSDT = investmentKRW / rate;

              // 3. 최신 데이터로 최종 기회 검증
              const verifiedOpportunity =
                await this.spreadCalculatorService.calculateSpread({
                  symbol: finalOpportunityCandidate.symbol,
                  upbitPrice: liveUpbitPrice,
                  binancePrice: liveBinancePrice,
                  investmentUSDT: investmentUSDT,
                });

              // 4. 최종 검증에서 기회가 유효하지 않다고 판단되면 (프리미엄 변동 등), 사이클을 리셋하고 종료
              if (!verifiedOpportunity) {
                this.logger.log(
                  `[FINAL_CHECK_FAIL] ${finalOpportunityCandidate.symbol.toUpperCase()}이(가) 최종 검증을 통과하지 못했습니다. 기회를 폐기합니다.`,
                );
                this.cycleStateService.resetCycleState();
                return;
              }

              // 5. 최종 검증까지 통과한 '진짜' 기회로만 거래 시작
              this.logger.log(
                `[FINAL_CHECK_SUCCESS] ${verifiedOpportunity.symbol.toUpperCase()} 최종 검증 통과. 거래를 시작합니다.`,
              );
              const hpResult =
                await this.highPremiumProcessorService.processHighPremiumOpportunity(
                  verifiedOpportunity, // 검증된 최종 기회를 전달
                );

              // 결과 처리 로직은 기존과 동일
              if (
                hpResult.success &&
                hpResult.nextStep === 'awaitLowPremium' &&
                hpResult.cycleId
              ) {
                this.logger.log(
                  `High premium processing successful (Cycle: ${hpResult.cycleId}). Awaiting low premium processing.`,
                );
              } else if (!hpResult.success) {
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
            } catch (error) {
              this.logger.error(
                `[FINAL_CHECK_ERROR] 최종 검증 중 예외 발생: ${error.message}`,
              );
              this.cycleStateService.resetCycleState();
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
    }
  }
}
