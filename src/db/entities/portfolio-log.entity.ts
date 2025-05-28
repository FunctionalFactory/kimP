// src/db/entities/portfolio-log.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ArbitrageCycle } from './arbitrage-cycle.entity'; // 연결할 ArbitrageCycle 엔티티

@Entity('portfolio_log') // 테이블명은 보통 소문자 스네이크 케이스 사용
export class PortfolioLog {
  @PrimaryGeneratedColumn('increment') // UUID를 사용하거나, 단순 auto-increment integer도 가능
  id: number;

  @CreateDateColumn({ type: 'datetime' }) // 로그 기록 시간 (자동 생성)
  timestamp: Date;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 2,
    comment: '업비트 KRW 잔고',
  })
  upbit_balance_krw: number;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 2,
    comment: '바이낸스 자산의 KRW 환산 총액',
  })
  binance_balance_krw: number;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 2,
    comment: '총 KRW 환산 잔고 (다음 사이클 투자금 기준)',
  })
  total_balance_krw: number;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 2,
    comment: '이전 사이클 순손익금 (KRW)',
  })
  cycle_pnl_krw: number;

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 4,
    comment: '이전 사이클 순손익률 (%)',
  })
  cycle_pnl_rate_percent: number;

  @ManyToOne(() => ArbitrageCycle, { nullable: true, onDelete: 'SET NULL' }) // ArbitrageCycle 삭제 시 이 필드는 NULL로 설정
  @JoinColumn({ name: 'linked_arbitrage_cycle_id' }) // 실제 DB 컬럼명
  linked_arbitrage_cycle: ArbitrageCycle | null; // 관계 설정

  @Column({
    type: 'uuid',
    nullable: true,
    comment: '이 로그를 발생시킨 차익거래 사이클 ID',
  })
  linked_arbitrage_cycle_id: string | null; // Foreign Key 필드를 명시적으로 추가

  @Column({
    type: 'text',
    nullable: true,
    comment: '비고 (예: 초기 자본 설정, 사이클 XXX 완료 등)',
  })
  remarks: string | null;
}
