// src/db/entities/arbitrage-cycle.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

// 모든 파일에서 공유할 수 있도록 상태 타입을 export 합니다.
export type ArbitrageCycleStatus =
  | 'STARTED' // 사이클 시작
  | 'HP_BOUGHT' // 고프리미엄 코인 매수 완료
  | 'HP_WITHDRAWN' // 고프리미엄 코인 출금 완료
  | 'HP_DEPOSITED' // 고프리미엄 코인 입금 확인
  | 'HP_SOLD' // 고프리미엄 코인 매도 완료
  | 'AWAITING_LP' // 저프리미엄 기회 탐색 중
  | 'LP_BOUGHT' // 저프리미엄 코인 매수 완료
  | 'LP_WITHDRAWN' // 저프리미엄 코인 출금 완료
  | 'LP_DEPOSITED' // 저프리미엄 코인 입금 확인
  | 'LP_SOLD' // 저프리미엄 코인 매도 완료
  | 'COMPLETED' // 전체 사이클 정상 완료
  | 'FAILED' // 사이클 실패
  | 'HP_ONLY_COMPLETED_TARGET_MISSED'; // 저프리미엄 기회를 못찾아 고프만으로 종료

@Entity('arbitrage_cycles')
export class ArbitrageCycle {
  @PrimaryGeneratedColumn('uuid') // UUID로 고유 ID 생성
  id: string;

  @CreateDateColumn({ name: 'start_time' })
  startTime: Date;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 8,
    nullable: true,
    name: 'initial_investment_usd',
  })
  initialInvestmentUsd: number;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 4,
    nullable: true,
    name: 'initial_investment_krw',
  })
  initialInvestmentKrw: number;

  // --- 고프리미엄 거래 정보 ---
  @Column({ nullable: true, name: 'high_premium_symbol' })
  highPremiumSymbol: string;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 8,
    nullable: true,
    name: 'high_premium_binance_buy_price_usd',
  })
  highPremiumBinanceBuyPriceUsd: number;

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 4,
    nullable: true,
    name: 'high_premium_initial_rate',
  })
  highPremiumInitialRate: number;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 8,
    nullable: true,
    name: 'high_premium_buy_amount',
  })
  highPremiumBuyAmount: number;

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 4,
    nullable: true,
    name: 'high_premium_spread_percent',
  })
  highPremiumSpreadPercent: number;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 4,
    nullable: true,
    name: 'high_premium_upbit_sell_price_krw',
  })
  highPremiumUpbitSellPriceKrw: number;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 4,
    nullable: true,
    name: 'high_premium_transfer_fee_krw',
  })
  highPremiumTransferFeeKrw: number; // 바이낸스 -> 업비트 코인 전송 수수료

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 4,
    nullable: true,
    name: 'high_premium_sell_fee_krw',
  })
  highPremiumSellFeeKrw: number; // 업비트 매도 수수료

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 4,
    nullable: true,
    name: 'high_premium_net_profit_krw',
  })
  highPremiumNetProfitKrw: number;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 8,
    nullable: true,
    name: 'high_premium_net_profit_usd',
  })
  highPremiumNetProfitUsd: number;

  @Column({
    type: 'timestamp',
    nullable: true,
    name: 'high_premium_completed_at',
  })
  highPremiumCompletedAt: Date;

  // --- 저프리미엄 거래 정보 ---
  @Column({ nullable: true, name: 'low_premium_symbol' })
  lowPremiumSymbol: string;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 4,
    nullable: true,
    name: 'low_premium_upbit_buy_price_krw',
  })
  lowPremiumUpbitBuyPriceKrw: number;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 8,
    nullable: true,
    name: 'low_premium_buy_amount',
  })
  lowPremiumBuyAmount: number;

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 4,
    nullable: true,
    name: 'low_premium_spread_percent',
  })
  lowPremiumSpreadPercent: number;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 8,
    nullable: true,
    name: 'low_premium_binance_sell_price_usd',
  })
  lowPremiumBinanceSellPriceUsd: number;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 4,
    nullable: true,
    name: 'low_premium_transfer_fee_krw',
  })
  lowPremiumTransferFeeKrw: number; // 업비트 -> 바이낸스 코인 전송 수수료

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 4,
    nullable: true,
    name: 'low_premium_sell_fee_krw',
  })
  lowPremiumSellFeeKrw: number; // 바이낸스 매도 수수료

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 4,
    nullable: true,
    name: 'low_premium_net_profit_krw',
  })
  lowPremiumNetProfitKrw: number;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 8,
    nullable: true,
    name: 'low_premium_net_profit_usd',
  })
  lowPremiumNetProfitUsd: number;

  // --- 전체 플로우 최종 결과 ---
  @UpdateDateColumn({ name: 'end_time', nullable: true })
  endTime: Date;

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 4,
    nullable: true,
    name: 'total_net_profit_percent',
  })
  totalNetProfitPercent: number;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 8,
    nullable: true,
    name: 'total_net_profit_usd',
  })
  totalNetProfitUsd: number;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 4,
    nullable: true,
    name: 'total_net_profit_krw',
  })
  totalNetProfitKrw: number;

  // --- 상태 및 상세 정보 ---
  @Column({ type: 'varchar', length: 50, nullable: true })
  status: ArbitrageCycleStatus;

  @Column({ nullable: true, name: 'hp_buy_tx_id' })
  highPremiumBuyTxId: string;

  @Column({ nullable: true, name: 'hp_withdraw_tx_id' })
  highPremiumWithdrawTxId: string;

  @Column({ nullable: true, name: 'hp_short_entry_tx_id' })
  hp_short_entry_tx_id: string; // 숏 포지션 진입 주문 ID

  @Column({ nullable: true, name: 'hp_short_close_tx_id' })
  hp_short_close_tx_id: string; // 숏 포지션 종료 주문 ID

  @Column({ nullable: true, name: 'lp_buy_tx_id' })
  lowPremiumBuyTxId: string;

  @Column({ nullable: true, name: 'lp_withdraw_tx_id' })
  lowPremiumWithdrawTxId: string;

  @Column({ nullable: true, name: 'lp_short_entry_tx_id' })
  lp_short_entry_tx_id: string; // LP 숏 포지션 진입 주문 ID

  @Column({ nullable: true, name: 'lp_short_close_tx_id' })
  lp_short_close_tx_id: string; // LP 숏 포지션 종료 주문 ID

  @Column({ type: 'text', nullable: true })
  errorDetails: string; // 오류 발생 시 상세 내용
}
