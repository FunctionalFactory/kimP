// src/db/entities/session-fund-validation.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('session_fund_validation')
export class SessionFundValidation {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @CreateDateColumn({ type: 'datetime' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt: Date;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 2,
    comment: '세션당 고정 투자금 (KRW)',
  })
  sessionInvestmentAmountKrw: number;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 2,
    comment: '필요한 최소 바이낸스 잔고 (투자금 + 3% 여유자금)',
  })
  requiredBinanceBalanceKrw: number;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 2,
    comment: '실제 바이낸스 잔고 (KRW 환산)',
  })
  actualBinanceBalanceKrw: number;

  @Column({
    type: 'boolean',
    comment: '자금 검증 통과 여부',
  })
  isFundSufficient: boolean;

  @Column({
    type: 'text',
    nullable: true,
    comment: '검증 실패 시 사유',
  })
  failureReason: string | null;

  @Column({
    type: 'varchar',
    length: 50,
    comment: '검증 상태 (PENDING, SUCCESS, FAILED)',
  })
  validationStatus: 'PENDING' | 'SUCCESS' | 'FAILED';

  @Column({
    type: 'text',
    nullable: true,
    comment: '추가 메모',
  })
  remarks: string | null;
}
