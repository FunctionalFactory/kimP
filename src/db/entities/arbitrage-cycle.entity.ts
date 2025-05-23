// src/db/entities/arbitrage-cycle.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

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
    name: 'high_premium_short_entry_fee_krw',
  })
  highPremiumShortEntryFeeKrw: number;

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
    name: 'high_premium_short_exit_fee_krw',
  })
  highPremiumShortExitFeeKrw: number;

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
    scale: 4,
    nullable: true,
    name: 'low_premium_short_entry_fee_krw',
  })
  lowPremiumShortEntryFeeKrw: number;

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
    name: 'low_premium_short_exit_fee_krw',
  })
  lowPremiumShortExitFeeKrw: number;

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

  @Column({ nullable: true })
  status: string; // 'IN_PROGRESS', 'HIGH_PREMIUM_COMPLETED', 'COMPLETED', 'FAILED' 등

  @Column({ type: 'text', nullable: true })
  errorDetails: string; // 오류 발생 시 상세 내용
}
