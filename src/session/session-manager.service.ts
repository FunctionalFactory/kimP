import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ISession, SessionStatus } from './interfaces/session.interface';
import { SessionStateService } from './session-state.service';
import { SessionExecutorService } from './session-executor.service';
import { ArbitrageFlowManagerService } from '../arbitrage/arbitrage-flow-manager.service';
import { PriceFeedService } from '../marketdata/price-feed.service';
import { SpreadCalculatorService } from '../common/spread-calculator.service';
import { PortfolioLogService } from '../db/portfolio-log.service';
import { ExchangeService } from '../common/exchange.service';
import { ConfigService } from '@nestjs/config';
import { SessionFundValidationService } from 'src/db/session-fund-validation.service';

@Injectable()
export class SessionManagerService implements OnModuleInit {
  private readonly logger = new Logger(SessionManagerService.name);

  constructor(
    private readonly sessionStateService: SessionStateService,
    private readonly sessionExecutorService: SessionExecutorService,
    private readonly arbitrageFlowManagerService: ArbitrageFlowManagerService,
    private readonly priceFeedService: PriceFeedService,
    private readonly spreadCalculatorService: SpreadCalculatorService,
    private readonly portfolioLogService: PortfolioLogService,
    private readonly exchangeService: ExchangeService,
    private readonly configService: ConfigService,
    private readonly sessionFundValidationService: SessionFundValidationService, // 추가
  ) {}

  onModuleInit() {
    this.logger.log('[SESSION_MANAGER] 세션 기반 병렬 처리 시스템 초기화 완료');
  }

  // 실시간 가격 업데이트 처리 (WsService에서 호출)
  async handlePriceUpdate(symbol: string): Promise<void> {
    this.logger.debug(`[SESSION_MANAGER] 실시간 가격 업데이트 처리: ${symbol}`);

    // 실시간 고프리미엄 기회 확인
    const opportunity = await this.checkHighPremiumOpportunity(symbol);

    if (opportunity) {
      // IDLE 세션이 있으면 해당 세션에서 처리
      const idleSessions = this.sessionStateService.getSessionsByStatus(
        SessionStatus.IDLE,
      );

      if (idleSessions.length > 0) {
        // 첫 번째 IDLE 세션에서 처리
        const session = idleSessions[0];
        await this.sessionExecutorService.executeHighPremiumOpportunity(
          session,
          opportunity,
        );
        this.logger.log(
          `[SESSION_MANAGER] 실시간 기회를 IDLE 세션에서 처리: ${session.id} - ${opportunity.symbol}`,
        );
      } else {
        // 새 세션 생성
        const session = await this.createHighPremiumSession(opportunity);
        if (session) {
          this.logger.log(
            `[SESSION_MANAGER] 실시간 기회 발견으로 새 세션 생성: ${session.id} - ${opportunity.symbol}`,
          );
        } else {
          this.logger.debug(
            `[SESSION_MANAGER] 자금 부족으로 세션 생성 건너뜀: ${opportunity.symbol}`,
          );
        }
      }
    }
  }

  // 고프리미엄 기회 발견 시 새 세션 생성
  async createHighPremiumSession(opportunityData: any): Promise<ISession> {
    this.logger.log(
      `[SESSION_MANAGER] 고프리미엄 세션 생성 시작: ${opportunityData.symbol}`,
    );

    const latestValidation =
      await this.sessionFundValidationService.getLatestValidationResult();

    let isFundSufficient = false;

    if (latestValidation && latestValidation.isFundSufficient) {
      // DB에 충분한 자금이 있다고 기록되어 있으면 통과
      isFundSufficient = true;
      this.logger.debug(
        `[SESSION_MANAGER] ✅ DB 기반 자금 검증 통과 - 실제 잔고: ${latestValidation.actualBinanceBalanceKrw.toLocaleString()} KRW`,
      );
    } else {
      // DB에 기록이 없거나 자금이 부족하면 실제 검증 수행
      this.logger.log(
        `[SESSION_MANAGER] DB에 유효한 자금 검증 결과 없음, 실제 검증 수행`,
      );
      isFundSufficient =
        await this.sessionFundValidationService.validateSessionFunds();
    }

    if (!isFundSufficient) {
      this.logger.warn(
        `[SESSION_MANAGER] ❌ 자금 부족으로 세션 생성 실패: ${opportunityData.symbol}`,
      );
      return null;
    }

    const session = this.sessionStateService.createSession();

    // 세션에 고프리미엄 데이터 설정
    session.highPremiumData = {
      symbol: opportunityData.symbol,
      investmentKRW: opportunityData.investmentKRW,
      investmentUSDT: opportunityData.investmentUSDT,
      expectedProfit: opportunityData.expectedProfit,
      executedAt: new Date(),
    };

    session.status = SessionStatus.HIGH_PREMIUM_PROCESSING;

    this.logger.log(`[SESSION_MANAGER] 고프리미엄 세션 생성: ${session.id}`);
    return session;
  }

  // 주기적으로 다음 세션 처리
  @Cron(CronExpression.EVERY_5_SECONDS)
  async processSessions() {
    await this.sessionExecutorService.processNextSession();
  }

  // 고프리미엄 기회 탐색 및 새 세션 생성
  @Cron(CronExpression.EVERY_10_SECONDS)
  async scanForHighPremiumOpportunities() {
    const idleSessions = this.sessionStateService.getSessionsByStatus(
      SessionStatus.IDLE,
    );

    // IDLE 세션이 있으면 기존 세션에서 처리
    if (idleSessions.length > 0) {
      this.logger.debug(
        `[SESSION_MANAGER] IDLE 세션 ${idleSessions.length}개가 있어 새 세션 생성을 건너뜁니다.`,
      );
      return;
    }

    // IDLE 세션이 없으면 새 세션 생성
    const watchedSymbols = this.priceFeedService.getWatchedSymbols();

    for (const symbolConfig of watchedSymbols) {
      const opportunity = await this.checkHighPremiumOpportunity(
        symbolConfig.symbol,
      );

      if (opportunity) {
        const session = await this.createHighPremiumSession(opportunity);
        if (session) {
          this.logger.log(
            `[SESSION_MANAGER] 고프리미엄 기회 발견으로 새 세션 생성: ${session.id} - ${opportunity.symbol}`,
          );
          break; // 하나의 기회만 처리
        } else {
          this.logger.debug(
            `[SESSION_MANAGER] 자금 부족으로 세션 생성 건너뜀: ${opportunity.symbol}`,
          );
        }
      }
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
        `[SESSION_MANAGER] 세션당 고정 투자금 사용: ${investmentKRW.toLocaleString()} KRW`,
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
        `[SESSION_MANAGER] 비율 기반 투자금 사용: ${investmentKRW.toLocaleString()} KRW (${investmentPercentage}%)`,
      );
    }

    const rate = this.exchangeService.getUSDTtoKRW();

    if (rate === 0) {
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

  // 세션 완료 처리
  async completeSession(sessionId: string, success: boolean): Promise<void> {
    const status = success ? SessionStatus.COMPLETED : SessionStatus.FAILED;
    this.sessionStateService.updateSessionStatus(sessionId, status);

    this.logger.log(`[SESSION_MANAGER] 세션 완료: ${sessionId} (${status})`);
  }

  // 세션 상태 조회
  getSessionStatus(): {
    total: number;
    idle: number;
    processing: number;
    awaiting: number;
    completed: number;
    failed: number;
  } {
    const allSessions = this.sessionStateService.getActiveSessions();
    const completedSessions = this.sessionStateService.getSessionsByStatus(
      SessionStatus.COMPLETED,
    );
    const failedSessions = this.sessionStateService.getSessionsByStatus(
      SessionStatus.FAILED,
    );

    return {
      total:
        allSessions.length + completedSessions.length + failedSessions.length,
      idle: this.sessionStateService.getSessionsByStatus(SessionStatus.IDLE)
        .length,
      processing: this.sessionStateService.getSessionsByStatus(
        SessionStatus.HIGH_PREMIUM_PROCESSING,
      ).length,
      awaiting: this.sessionStateService.getSessionsByStatus(
        SessionStatus.AWAITING_LOW_PREMIUM,
      ).length,
      completed: completedSessions.length,
      failed: failedSessions.length,
    };
  }
}
