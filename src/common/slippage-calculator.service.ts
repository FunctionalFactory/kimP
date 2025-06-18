// src/common/slippage-calculator.service.ts
import { Injectable } from '@nestjs/common';
import { OrderBook, OrderSide } from './exchange.interface';

export interface SlippageResult {
  averagePrice: number; // 평균 체결 단가
  totalAmount: number; // 총 체결 수량
  totalCost: number; // 총 지불 비용 (매수 시) 또는 총 수령액 (매도 시)
  slippagePercent: number; // 슬리피지 비율 (%)
}

@Injectable()
export class SlippageCalculatorService {
  /**
   * 오더북과 투자 금액을 기반으로 예상 슬리피지를 계산합니다.
   * @param orderBook 호가창 데이터
   * @param side 'buy' 또는 'sell'
   * @param investmentAmount 투자할 금액 (KRW 또는 USDT)
   * @returns SlippageResult
   */
  calculate(
    orderBook: OrderBook,
    side: OrderSide,
    investmentAmount: number,
  ): SlippageResult {
    // 매수일 경우, 매도 호가(asks)를 기준으로 계산
    const levels = side === 'buy' ? orderBook.asks : orderBook.bids;
    // 매수일 경우, 가장 유리한 가격은 가장 낮은 매도 호가
    const bestPrice = levels[0]?.price;

    if (!bestPrice) {
      throw new Error('Order book is empty.');
    }

    let totalCost = 0;
    let totalAmount = 0;

    for (const level of levels) {
      const levelPrice = level.price;
      const levelAmount = level.amount;
      const levelValue = levelPrice * levelAmount;

      const remainingInvestment = investmentAmount - totalCost;

      if (remainingInvestment <= 0) {
        break;
      }

      // 현재 호가 단계에서 모든 물량을 사도 투자금을 다 못쓰는 경우
      if (remainingInvestment > levelValue) {
        totalCost += levelValue;
        totalAmount += levelAmount;
      } else {
        // 현재 호가 단계에서 투자금을 모두 소진하는 경우
        const amountToProcess = remainingInvestment / levelPrice;
        totalCost += amountToProcess * levelPrice; // 사실상 remainingInvestment를 더하는 것
        totalAmount += amountToProcess;
        break; // 투자금을 모두 사용했으므로 종료
      }
    }

    if (totalAmount === 0) {
      return {
        averagePrice: 0,
        totalAmount: 0,
        totalCost: 0,
        slippagePercent: 0,
      };
    }

    const averagePrice = totalCost / totalAmount;

    // 슬리피지 계산: (실제 평균 체결가 / 가장 유리한 호가) - 1
    // 매수일 경우 평균가가 더 높으므로 양수, 매도일 경우 평균가가 더 낮으므로 음수가 됨. 비용 관점에서 절대값으로 취급 가능.
    const slippagePercent =
      side === 'buy'
        ? (averagePrice / bestPrice - 1) * 100
        : (averagePrice / bestPrice - 1) * 100;

    return {
      averagePrice,
      totalAmount,
      totalCost,
      slippagePercent,
    };
  }
}
