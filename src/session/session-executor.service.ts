import { Injectable, Logger } from '@nestjs/common';
import { ISession, SessionStatus } from './interfaces/session.interface';
import { SessionStateService } from './session-state.service';
import { SessionPriorityService } from './session-priority.service';
import { ArbitrageFlowManagerService } from '../arbitrage/arbitrage-flow-manager.service';
import { HighPremiumProcessorService } from '../arbitrage/high-premium-processor.service';
import {
  LowPremiumProcessorService,
  LowPremiumResult,
} from '../arbitrage/low-premium-processor.service';
import { PriceFeedService } from '../marketdata/price-feed.service';
import { SpreadCalculatorService } from '../common/spread-calculator.service';
import { PortfolioLogService } from '../db/portfolio-log.service';
import { ExchangeService } from '../common/exchange.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class SessionExecutorService {
  private readonly logger = new Logger(SessionExecutorService.name);
  private isProcessing = false;
  private readonly DECISION_WINDOW_MS = 2000; // 2초의 결정 시간

  constructor(
    private readonly sessionStateService: SessionStateService,
    private readonly sessionPriorityService: SessionPriorityService,
    private readonly arbitrageFlowManagerService: ArbitrageFlowManagerService,
    private readonly highPremiumProcessorService: HighPremiumProcessorService,
    private readonly lowPremiumProcessorService: LowPremiumProcessorService,
    private readonly priceFeedService: PriceFeedService,
    private readonly spreadCalculatorService: SpreadCalculatorService,
    private readonly portfolioLogService: PortfolioLogService,
    private readonly exchangeService: ExchangeService,
    private readonly configService: ConfigService,
  ) {}

  async processNextSession(): Promise<void> {
    if (this.isProcessing) {
      this.logger.debug('[EXECUTOR] 이미 처리 중입니다.');
      return;
    }

    this.isProcessing = true;

    try {
      const activeSessions = this.sessionStateService.getActiveSessions();
      const nextSession =
        this.sessionPriorityService.getNextSessionToProcess(activeSessions);

      if (!nextSession) {
        this.logger.debug('[EXECUTOR] 처리할 세션이 없습니다.');
        return;
      }

      await this.executeSession(nextSession);
    } finally {
      this.isProcessing = false;
    }
  }

  private async executeSession(session: ISession): Promise<void> {
    this.logger.log(
      `[EXECUTOR] 세션 실행 시작: ${session.id} (${session.status})`,
    );

    switch (session.status) {
      case SessionStatus.IDLE:
        await this.handleIdleSession(session);
        break;

      case SessionStatus.AWAITING_LOW_PREMIUM:
        await this.handleLowPremiumSession(session);
        break;

      case SessionStatus.HIGH_PREMIUM_PROCESSING:
        // 이미 처리 중인 상태는 건너뛰기
        this.logger.debug(
          `[EXECUTOR] 세션 ${session.id}가 이미 고프리미엄 처리 중입니다.`,
        );
        break;

      default:
        this.logger.warn(
          `[EXECUTOR] 처리할 수 없는 세션 상태: ${session.status}`,
        );
    }
  }

  private async handleIdleSession(session: ISession): Promise<void> {
    this.logger.log(`[EXECUTOR] IDLE 세션 ${session.id} 처리 시작`);

    // 모든 심볼에 대해 고프리미엄 기회 탐색
    const watchedSymbols = this.priceFeedService.getWatchedSymbols();

    for (const symbolConfig of watchedSymbols) {
      const opportunity = await this.checkHighPremiumOpportunity(
        symbolConfig.symbol,
      );

      if (opportunity) {
        // 고프리미엄 기회 발견 시 세션 상태 업데이트
        session.highPremiumData = {
          symbol: opportunity.symbol,
          investmentKRW: opportunity.investmentKRW,
          investmentUSDT: opportunity.investmentUSDT,
          expectedProfit: opportunity.netProfit,
          executedAt: new Date(),
        };

        session.status = SessionStatus.HIGH_PREMIUM_PROCESSING;
        this.sessionStateService.updateSessionStatus(
          session.id,
          SessionStatus.HIGH_PREMIUM_PROCESSING,
        );

        // 고프리미엄 처리 실행
        await this.executeHighPremiumProcessing(session, opportunity);
        break; // 하나의 기회만 처리
      }
    }
  }

  async executeHighPremiumOpportunity(
    session: ISession,
    opportunity: any,
  ): Promise<void> {
    this.logger.log(
      `[EXECUTOR] 실시간 고프리미엄 기회 실행: ${session.id} - ${opportunity.symbol}`,
    );

    // 세션에 고프리미엄 데이터 설정
    session.highPremiumData = {
      symbol: opportunity.symbol,
      investmentKRW: opportunity.investmentKRW,
      investmentUSDT: opportunity.investmentUSDT,
      expectedProfit: opportunity.netProfit,
      executedAt: new Date(),
    };

    session.status = SessionStatus.HIGH_PREMIUM_PROCESSING;
    this.sessionStateService.updateSessionStatus(
      session.id,
      SessionStatus.HIGH_PREMIUM_PROCESSING,
    );

    // 고프리미엄 처리 실행
    await this.executeHighPremiumProcessing(session, opportunity);
  }

  private async handleLowPremiumSession(session: ISession): Promise<void> {
    this.logger.log(`[EXECUTOR] 저프리미엄 세션 ${session.id} 처리 시작`);

    if (!session.lowPremiumData || !session.highPremiumData) {
      this.logger.error(
        `[EXECUTOR] 세션 ${session.id}에 필요한 데이터가 없습니다.`,
      );
      return;
    }

    // 저프리미엄 처리 실행
    const result: LowPremiumResult | null =
      await this.lowPremiumProcessorService.processLowPremiumOpportunity();

    if (result && result.cycleId) {
      this.logger.log(
        `[EXECUTOR] 저프리미엄 처리 완료: ${result.cycleId} (성공: ${result.success})`,
      );

      // 세션 완료 처리
      const success = result.success;
      session.status = success ? SessionStatus.COMPLETED : SessionStatus.FAILED;
      this.sessionStateService.updateSessionStatus(session.id, session.status);
    } else {
      this.logger.debug(`[EXECUTOR] 저프리미엄 처리 결과가 없습니다.`);
    }
  }

  private async checkHighPremiumOpportunity(symbol: string): Promise<any> {
    const upbitPrice = this.priceFeedService.getUpbitPrice(symbol);
    const binancePrice = this.priceFeedService.getBinancePrice(symbol);

    if (upbitPrice === undefined || binancePrice === undefined) {
      return null;
    }

    // 세션당 고정 투자금 설정
    const investmentStrategy =
      this.configService.get<string>('INVESTMENT_STRATEGY') || 'FIXED_AMOUNT';
    let investmentKRW: number;

    if (investmentStrategy === 'FIXED_AMOUNT') {
      // 세션당 고정 금액 사용
      investmentKRW =
        this.configService.get<number>('SESSION_INVESTMENT_AMOUNT_KRW') ||
        100000;
      this.logger.debug(
        `[EXECUTOR] 세션당 고정 투자금 사용: ${investmentKRW.toLocaleString()} KRW`,
      );
    } else {
      // 기존 비율 기반 투자 (백워드 호환성)
      const latestPortfolio =
        await this.portfolioLogService.getLatestPortfolio();
      const totalCapitalKRW =
        latestPortfolio?.total_balance_krw ||
        this.configService.get<number>('INITIAL_CAPITAL_KRW');
      const investmentPercentage =
        this.configService.get<number>('INVESTMENT_PERCENTAGE') || 10;
      investmentKRW = Number(totalCapitalKRW) * (investmentPercentage / 100);
      this.logger.debug(
        `[EXECUTOR] 비율 기반 투자금 사용: ${investmentKRW.toLocaleString()} KRW (${investmentPercentage}%)`,
      );
    }

    const rate = this.exchangeService.getUSDTtoKRW();

    if (rate === 0) {
      this.logger.warn('[EXECUTOR] 환율이 0입니다. 기회 확인을 건너뜁니다.');
      return null;
    }

    const investmentUSDT = investmentKRW / rate;

    const opportunity = await this.spreadCalculatorService.calculateSpread({
      symbol,
      upbitPrice,
      binancePrice,
      investmentUSDT,
    });

    return opportunity;
  }

  private async executeHighPremiumProcessing(
    session: ISession,
    opportunity: any,
  ): Promise<void> {
    this.logger.log(
      `[EXECUTOR] 고프리미엄 처리 시작: ${session.id} - ${opportunity.symbol}`,
    );

    try {
      const hpResult =
        await this.highPremiumProcessorService.processHighPremiumOpportunity(
          opportunity,
        );

      if (
        hpResult.success &&
        hpResult.nextStep === 'awaitLowPremium' &&
        hpResult.cycleId
      ) {
        // 고프리미엄 성공, 저프리미엄 대기 상태로 전환
        session.cycleId = hpResult.cycleId;
        session.lowPremiumData = {
          requiredProfit: opportunity.netProfit,
          allowedLoss: opportunity.netProfit * 0.5, // 허용 손실은 수익의 50%
          searchStartTime: new Date(),
        };

        session.status = SessionStatus.AWAITING_LOW_PREMIUM;
        this.sessionStateService.updateSessionStatus(
          session.id,
          SessionStatus.AWAITING_LOW_PREMIUM,
        );

        this.logger.log(
          `[EXECUTOR] 고프리미엄 처리 성공. 저프리미엄 대기 상태로 전환: ${session.id}`,
        );
      } else {
        // 고프리미엄 실패
        session.status = SessionStatus.FAILED;
        this.sessionStateService.updateSessionStatus(
          session.id,
          SessionStatus.FAILED,
        );

        this.logger.error(`[EXECUTOR] 고프리미엄 처리 실패: ${session.id}`);
      }
    } catch (error) {
      this.logger.error(`[EXECUTOR] 고프리미엄 처리 중 오류: ${error.message}`);
      session.status = SessionStatus.FAILED;
      this.sessionStateService.updateSessionStatus(
        session.id,
        SessionStatus.FAILED,
      );
    }
  }
}
