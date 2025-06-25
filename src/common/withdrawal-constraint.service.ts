// src/common/withdrawal-constraint.service.ts
import { Injectable, Logger } from '@nestjs/common';

export interface WithdrawalConstraint {
  symbol: string;
  minWithdrawal: number;
  withdrawalPrecision: number; // 출금 가능한 소수점 자릿수
  mustBeInteger: boolean; // 정수만 가능한지 여부
}

@Injectable()
export class WithdrawalConstraintService {
  private readonly logger = new Logger(WithdrawalConstraintService.name);

  // 코인별 출금 제약 조건 정의
  private readonly withdrawalConstraints: Map<string, WithdrawalConstraint> =
    new Map([
      [
        'NEO',
        {
          symbol: 'NEO',
          minWithdrawal: 1,
          withdrawalPrecision: 0,
          mustBeInteger: true,
        },
      ],
    ]);

  /**
   * 코인의 출금 제약 조건을 조회합니다.
   */
  getWithdrawalConstraint(symbol: string): WithdrawalConstraint | null {
    const upperSymbol = symbol.toUpperCase();
    return this.withdrawalConstraints.get(upperSymbol) || null;
  }

  /**
   * 출금 수량을 코인별 제약 조건에 맞게 조정합니다.
   */
  adjustWithdrawalAmount(symbol: string, amount: number): number {
    const constraint = this.getWithdrawalConstraint(symbol);

    if (!constraint) {
      this.logger.warn(
        `[WITHDRAWAL_CONSTRAINT] No constraint found for ${symbol}, using default precision`,
      );
      return parseFloat(amount.toFixed(8));
    }

    let adjustedAmount = amount;

    // 최소 출금량 확인
    if (adjustedAmount < constraint.minWithdrawal) {
      this.logger.warn(
        `[WITHDRAWAL_CONSTRAINT] ${symbol} amount ${adjustedAmount} is below minimum ${constraint.minWithdrawal}. Cannot withdraw.`,
      );
      throw new Error(
        `${symbol} withdrawal amount ${adjustedAmount} is below minimum ${constraint.minWithdrawal}`,
      );
    }

    // 정수만 허용하는 코인의 경우
    if (constraint.mustBeInteger) {
      adjustedAmount = Math.floor(adjustedAmount);
      this.logger.log(
        `[WITHDRAWAL_CONSTRAINT] ${symbol} requires integer amount. Adjusted from ${amount} to ${adjustedAmount}`,
      );
    } else {
      // 소수점 자릿수 조정
      adjustedAmount = parseFloat(
        adjustedAmount.toFixed(constraint.withdrawalPrecision),
      );
      this.logger.log(
        `[WITHDRAWAL_CONSTRAINT] ${symbol} adjusted to ${constraint.withdrawalPrecision} decimal places: ${amount} → ${adjustedAmount}`,
      );
    }

    // 조정 후 최소 출금량 재확인
    if (adjustedAmount < constraint.minWithdrawal) {
      this.logger.warn(
        `[WITHDRAWAL_CONSTRAINT] ${symbol} adjusted amount ${adjustedAmount} is below minimum ${constraint.minWithdrawal}. Cannot withdraw.`,
      );
      throw new Error(
        `${symbol} adjusted withdrawal amount ${adjustedAmount} is below minimum ${constraint.minWithdrawal}`,
      );
    }

    return adjustedAmount;
  }

  /**
   * 출금 가능한지 확인합니다.
   */
  canWithdraw(symbol: string, amount: number): boolean {
    try {
      const adjustedAmount = this.adjustWithdrawalAmount(symbol, amount);
      return adjustedAmount > 0;
    } catch {
      return false;
    }
  }

  /**
   * 출금 수량 조정 시 손실되는 금액을 계산합니다.
   */
  calculateLossFromAdjustment(symbol: string, originalAmount: number): number {
    try {
      const adjustedAmount = this.adjustWithdrawalAmount(
        symbol,
        originalAmount,
      );
      return originalAmount - adjustedAmount;
    } catch {
      return originalAmount; // 조정 불가능한 경우 전체 금액 손실
    }
  }
}
