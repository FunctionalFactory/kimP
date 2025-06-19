// src/db/portfolio-log.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PortfolioLog } from './entities/portfolio-log.entity';

@Injectable()
export class PortfolioLogService {
  private readonly logger = new Logger(PortfolioLogService.name);

  constructor(
    @InjectRepository(PortfolioLog)
    private readonly portfolioLogRepository: Repository<PortfolioLog>,
  ) {}

  // WsService에서 가져온 parseAndValidateNumber 함수 또는 유사한 기능
  private parseToNumber(value: any): number | null {
    if (value === null || value === undefined) {
      return null;
    }
    const num = Number(value); // 또는 parseFloat(value)
    return isNaN(num) ? null : num;
  }

  async createLog(data: {
    timestamp: Date;
    upbit_balance_krw: number;
    binance_balance_krw: number;
    total_balance_krw: number;
    cycle_pnl_krw: number;
    cycle_pnl_rate_percent: number;
    linked_arbitrage_cycle_id?: string | null;
    remarks?: string | null;
  }): Promise<PortfolioLog> {
    try {
      const newLogData: Partial<PortfolioLog> = {
        timestamp: data.timestamp,
        upbit_balance_krw: data.upbit_balance_krw,
        binance_balance_krw: data.binance_balance_krw,
        total_balance_krw: data.total_balance_krw,
        cycle_pnl_krw: data.cycle_pnl_krw,
        cycle_pnl_rate_percent: data.cycle_pnl_rate_percent,
        remarks: data.remarks,
      };

      if (data.linked_arbitrage_cycle_id) {
        newLogData.linked_arbitrage_cycle_id = data.linked_arbitrage_cycle_id;
      }

      const newLog = this.portfolioLogRepository.create(newLogData);
      const savedLog = await this.portfolioLogRepository.save(newLog);

      // 🌶️ 로깅 전 숫자 변환
      const totalBalanceForLog = this.parseToNumber(savedLog.total_balance_krw);
      const cyclePnlForLog = this.parseToNumber(savedLog.cycle_pnl_krw);

      this.logger.log(
        `새 포트폴리오 로그 생성됨: ID ${savedLog.id}, 총 잔고 ${totalBalanceForLog !== null ? totalBalanceForLog.toFixed(0) : 'N/A'} KRW, 직전 사이클 PNL: ${cyclePnlForLog !== null ? cyclePnlForLog.toFixed(0) : 'N/A'} KRW`,
      );
      return savedLog;
    } catch (error) {
      this.logger.error(
        `포트폴리오 로그 생성 실패: ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    }
  }

  async getLatestPortfolio(): Promise<PortfolioLog | null> {
    try {
      const logs = await this.portfolioLogRepository.find({
        order: { timestamp: 'DESC' },
        take: 1,
      });

      const latestLog = logs.length > 0 ? logs[0] : null;

      if (latestLog) {
        // 🌶️ 로깅 전 숫자 변환
        const totalBalanceForLog = this.parseToNumber(
          latestLog.total_balance_krw,
        );

        this.logger.verbose(
          `가장 최근 포트폴리오 로그 조회됨: ID ${latestLog.id}, 총 잔고 ${totalBalanceForLog !== null ? totalBalanceForLog.toFixed(0) : 'N/A'} KRW (Timestamp: ${latestLog.timestamp.toISOString()})`,
        );
      } else {
        // this.logger.warn(
        //   '조회된 포트폴리오 로그가 없습니다. 초기 자본 설정이 필요할 수 있습니다.',
        // );
      }
      return latestLog;
    } catch (error) {
      this.logger.error(
        `최근 포트폴리오 로그 조회 실패: ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    }
  }
}
