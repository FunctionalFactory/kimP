// src/db/portfolio-log.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PortfolioLog } from './entities/portfolio-log.entity';
import { ArbitrageCycle } from './entities/arbitrage-cycle.entity'; // ArbitrageCycle 타입 임포트

@Injectable()
export class PortfolioLogService {
  private readonly logger = new Logger(PortfolioLogService.name);

  constructor(
    @InjectRepository(PortfolioLog)
    private readonly portfolioLogRepository: Repository<PortfolioLog>,
  ) {}

  /**
   * 새로운 포트폴리오 로그를 생성합니다.
   * @param data PortfolioLog 생성에 필요한 데이터
   * @returns 저장된 PortfolioLog 객체
   */
  async createLog(data: {
    timestamp: Date;
    upbit_balance_krw: number;
    binance_balance_krw: number;
    total_balance_krw: number;
    cycle_pnl_krw: number;
    cycle_pnl_rate_percent: number;
    linked_arbitrage_cycle_id?: string | null; // Nullable로 변경
    remarks?: string | null; // Nullable로 변경
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

      // linked_arbitrage_cycle_id가 제공된 경우에만 관계 설정 시도
      if (data.linked_arbitrage_cycle_id) {
        newLogData.linked_arbitrage_cycle_id = data.linked_arbitrage_cycle_id;
        // 만약 ArbitrageCycle 엔티티 객체 자체를 연결하려면 아래와 같이 할 수 있으나,
        // ID만 저장하는 것이 더 간단할 수 있습니다.
        // newLogData.linked_arbitrage_cycle = { id: data.linked_arbitrage_cycle_id } as ArbitrageCycle;
      }

      const newLog = this.portfolioLogRepository.create(newLogData);
      const savedLog = await this.portfolioLogRepository.save(newLog);
      this.logger.log(
        `새 포트폴리오 로그 생성됨: ID ${savedLog.id}, 총 잔고 ${savedLog.total_balance_krw.toFixed(0)} KRW, 직전 사이클 PNL: ${savedLog.cycle_pnl_krw.toFixed(0)} KRW`,
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

  /**
   * 가장 최근의 포트폴리오 로그를 조회합니다.
   * @returns 가장 최근의 PortfolioLog 객체 또는 null
   */
  async getLatestPortfolio(): Promise<PortfolioLog | null> {
    try {
      const latestLog = await this.portfolioLogRepository.findOne({
        order: { timestamp: 'DESC' }, // 가장 최근 timestamp 기준
      });
      if (latestLog) {
        this.logger.verbose(
          `가장 최근 포트폴리오 로그 조회됨: ID ${latestLog.id}, 총 잔고 ${latestLog.total_balance_krw.toFixed(0)} KRW (Timestamp: ${latestLog.timestamp.toISOString()})`,
        );
      } else {
        this.logger.warn(
          '조회된 포트폴리오 로그가 없습니다. 초기 자본 설정이 필요할 수 있습니다.',
        );
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

  // 추가적으로 필요할 수 있는 메소드 (예시)
  // async getPortfolioHistory(limit: number = 100): Promise<PortfolioLog[]> {
  //   return this.portfolioLogRepository.find({
  //     order: { timestamp: 'DESC' },
  //     take: limit,
  //   });
  // }
}
