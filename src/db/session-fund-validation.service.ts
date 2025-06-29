// src/db/session-fund-validation.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SessionFundValidation } from './entities/session-fund-validation.entity';
import { ConfigService } from '@nestjs/config';
import { ExchangeService } from '../common/exchange.service';

@Injectable()
export class SessionFundValidationService {
  private readonly logger = new Logger(SessionFundValidationService.name);

  constructor(
    @InjectRepository(SessionFundValidation)
    private readonly sessionFundValidationRepository: Repository<SessionFundValidation>,
    private readonly configService: ConfigService,
    private readonly exchangeService: ExchangeService,
  ) {}

  /**
   * 세션 생성 전 자금 검증 수행
   * @returns 검증 결과 (true: 통과, false: 실패)
   */
  async validateSessionFunds(): Promise<boolean> {
    this.logger.log('[FUND_VALIDATION] 세션 자금 검증 시작');

    try {
      // 1. 세션 투자금 설정 가져오기
      const sessionInvestmentAmountKrw =
        this.configService.get<number>('SESSION_INVESTMENT_AMOUNT_KRW') ||
        250000; // 기본값 25만원

      // 2. 필요한 최소 바이낸스 잔고 계산 (투자금 + 3% 여유자금)
      const requiredBinanceBalanceKrw = sessionInvestmentAmountKrw * 1.03;

      // 3. 실제 바이낸스 잔고 조회
      const actualBinanceBalanceKrw = await this.getBinanceBalanceKrw();

      // 4. 검증 수행
      const isFundSufficient =
        actualBinanceBalanceKrw >= requiredBinanceBalanceKrw;

      // 5. 검증 결과 저장
      const validationRecord = this.sessionFundValidationRepository.create({
        sessionInvestmentAmountKrw,
        requiredBinanceBalanceKrw,
        actualBinanceBalanceKrw,
        isFundSufficient,
        failureReason: isFundSufficient ? null : '바이낸스 잔고 부족',
        validationStatus: isFundSufficient ? 'SUCCESS' : 'FAILED',
        remarks: `세션 투자금: ${sessionInvestmentAmountKrw.toLocaleString()} KRW, 필요 잔고: ${requiredBinanceBalanceKrw.toLocaleString()} KRW, 실제 잔고: ${actualBinanceBalanceKrw.toLocaleString()} KRW`,
      });

      await this.sessionFundValidationRepository.save(validationRecord);

      // 6. 로그 출력
      if (isFundSufficient) {
        this.logger.log(
          `[FUND_VALIDATION] ✅ 자금 검증 통과 - 실제 잔고: ${actualBinanceBalanceKrw.toLocaleString()} KRW (필요: ${requiredBinanceBalanceKrw.toLocaleString()} KRW)`,
        );
      } else {
        this.logger.warn(
          `[FUND_VALIDATION] ❌ 자금 검증 실패 - 실제 잔고: ${actualBinanceBalanceKrw.toLocaleString()} KRW (필요: ${requiredBinanceBalanceKrw.toLocaleString()} KRW)`,
        );
      }

      return isFundSufficient;
    } catch (error) {
      this.logger.error(
        `[FUND_VALIDATION] 자금 검증 중 오류 발생: ${error.message}`,
      );

      // 오류 발생 시에도 검증 기록 저장
      const errorRecord = this.sessionFundValidationRepository.create({
        sessionInvestmentAmountKrw:
          this.configService.get<number>('SESSION_INVESTMENT_AMOUNT_KRW') ||
          250000,
        requiredBinanceBalanceKrw: 0,
        actualBinanceBalanceKrw: 0,
        isFundSufficient: false,
        failureReason: `검증 중 오류 발생: ${error.message}`,
        validationStatus: 'FAILED',
        remarks: '자금 검증 프로세스 오류',
      });

      await this.sessionFundValidationRepository.save(errorRecord);

      return false; // 오류 발생 시 안전하게 false 반환
    }
  }

  /**
   * 바이낸스 잔고를 KRW로 환산하여 조회
   */
  private async getBinanceBalanceKrw(): Promise<number> {
    try {
      // ExchangeService를 통해 바이낸스 잔고 조회
      const binanceBalances = await this.exchangeService.getBalances('binance');

      if (!binanceBalances || binanceBalances.length === 0) {
        this.logger.warn('[FUND_VALIDATION] 바이낸스 잔고 조회 실패');
        return 0;
      }

      const usdtBalance = binanceBalances.find(
        (balance) => balance.currency === 'USDT',
      );

      if (!usdtBalance) {
        this.logger.warn('[FUND_VALIDATION] 바이낸스 USDT 잔고 없음');
        return 0;
      }

      const usdtAmount = usdtBalance.available; // 사용 가능한 USDT 잔고

      // USDT 잔고를 KRW로 환산
      const usdtToKrwRate = this.exchangeService.getUSDTtoKRW();
      const binanceBalanceKrw = usdtAmount * usdtToKrwRate;

      this.logger.debug(
        `[FUND_VALIDATION] 바이낸스 잔고: ${usdtAmount.toFixed(2)} USDT (${binanceBalanceKrw.toLocaleString()} KRW)`,
      );

      return binanceBalanceKrw;
    } catch (error) {
      this.logger.error(
        `[FUND_VALIDATION] 바이낸스 잔고 조회 중 오류: ${error.message}`,
      );
      return 0;
    }
  }

  /**
   * 최근 검증 결과 조회
   */
  async getLatestValidationResult(): Promise<SessionFundValidation | null> {
    return this.sessionFundValidationRepository.findOne({
      where: {},
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * 특정 기간 내 검증 결과 조회
   */
  async getValidationResultsByPeriod(
    startDate: Date,
    endDate: Date,
  ): Promise<SessionFundValidation[]> {
    return this.sessionFundValidationRepository.find({
      where: {
        createdAt: {
          $gte: startDate,
          $lte: endDate,
        } as any,
      },
      order: { createdAt: 'DESC' },
    });
  }
}
