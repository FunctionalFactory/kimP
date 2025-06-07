// src/common/strategy-high.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ArbitrageRecordService } from '../db/arbitrage-record.service';
import { ExchangeService, ExchangeType } from './exchange.service';
import { Order } from './exchange.interface';

// 유틸리티 함수: 지정된 시간(ms)만큼 대기
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class StrategyHighService {
  private readonly logger = new Logger(StrategyHighService.name);

  // 폴링 관련 설정 (나중에 .env로 옮기는 것을 추천)
  private readonly POLLING_INTERVAL_MS = 3000; // 3초
  private readonly ORDER_TIMEOUT_MS = 180000; // 3분
  private readonly DEPOSIT_TIMEOUT_MS = 600000; // 10분

  constructor(
    private readonly exchangeService: ExchangeService,
    private readonly arbitrageRecordService: ArbitrageRecordService,
  ) {}

  async handleHighPremiumFlow(
    symbol: string,
    upbitPrice: number,
    binancePrice: number,
    rate: number,
    cycleId: string,
    actualInvestmentUSDT: number,
  ): Promise<void> {
    this.logger.log(
      `[STRATEGY_HIGH] Starting trade process for cycle ${cycleId}`,
    );

    try {
      // 0. 사전 안전 점검
      const binanceWalletStatus = await this.exchangeService.getWalletStatus(
        'binance',
        symbol,
      );
      if (!binanceWalletStatus.canWithdraw) {
        throw new Error(
          `Binance wallet for ${symbol} has withdrawal disabled.`,
        );
      }
      const upbitWalletStatus = await this.exchangeService.getWalletStatus(
        'upbit',
        symbol,
      );
      if (!upbitWalletStatus.canDeposit) {
        throw new Error(`Upbit wallet for ${symbol} has deposit disabled.`);
      }
      this.logger.log(`[STRATEGY_HIGH] Wallet status check OK for ${symbol}`);

      // 1. 바이낸스 매수
      // TODO: getOrderBook으로 호가창 확인 후, 지정가(limit)로 주문 가격 결정
      const buyAmount = actualInvestmentUSDT / binancePrice;
      const buyOrder = await this.exchangeService.createOrder(
        'binance',
        symbol,
        'limit',
        'buy',
        buyAmount,
        binancePrice,
      );

      const filledBuyOrder = await this.pollOrderStatus(
        cycleId,
        'binance',
        buyOrder.id,
      );
      await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
        status: 'HP_BOUGHT',
        highPremiumBuyTxId: filledBuyOrder.id,
      });
      this.logger.log(
        `[STRATEGY_HIGH] Binance buy order for ${symbol} filled.`,
      );

      // 2. 업비트로 출금
      const { address: upbitAddress, tag: upbitTag } =
        await this.exchangeService.getDepositAddress('upbit', symbol);
      // 실제 체결된 수량으로 출금 요청
      const withdrawalResult = await this.exchangeService.withdraw(
        'binance',
        symbol,
        upbitAddress,
        filledBuyOrder.filledAmount.toString(),
        upbitTag,
      );
      await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
        status: 'HP_WITHDRAWN',
        highPremiumWithdrawTxId: withdrawalResult.id,
      });
      this.logger.log(
        `[STRATEGY_HIGH] Withdrawal from Binance to Upbit initiated.`,
      );

      // 3. 업비트 입금 확인
      await this.pollDepositConfirmation(
        cycleId,
        'upbit',
        symbol,
        filledBuyOrder.filledAmount,
      );
      await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
        status: 'HP_DEPOSITED',
      });
      this.logger.log(`[STRATEGY_HIGH] Deposit to Upbit confirmed.`);

      // 4. 업비트 매도
      const sellOrder = await this.exchangeService.createOrder(
        'upbit',
        symbol,
        'limit',
        'sell',
        filledBuyOrder.filledAmount,
        upbitPrice,
      );
      const filledSellOrder = await this.pollOrderStatus(
        cycleId,
        'upbit',
        sellOrder.id,
      );

      // 5. 최종 손익 계산 및 DB 업데이트
      const krwProceeds =
        filledSellOrder.filledAmount * filledSellOrder.price -
        (filledSellOrder.fee.cost || 0);
      const initialInvestmentKrw =
        filledBuyOrder.filledAmount * filledBuyOrder.price * rate +
        (filledBuyOrder.fee.cost || 0) * rate;
      const finalProfitKrw = krwProceeds - initialInvestmentKrw; // TODO: 전송 수수료 추가 계산 필요

      await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
        status: 'HP_SOLD',
        highPremiumNetProfitKrw: finalProfitKrw,
        highPremiumUpbitSellPriceKrw: filledSellOrder.price, // 실제 체결가로 업데이트
        highPremiumBinanceBuyPriceUsd: filledBuyOrder.price, // 실제 체결가로 업데이트
        highPremiumCompletedAt: new Date(),
      });
      this.logger.log(
        `[STRATEGY_HIGH] Upbit sell order for ${symbol} filled. High premium leg completed.`,
      );
    } catch (error) {
      this.logger.error(
        `[STRATEGY_HIGH] CRITICAL ERROR during cycle ${cycleId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
        status: 'FAILED',
        errorDetails: `High Premium Leg Failed: ${(error as Error).message}`,
      });
    }
  }

  /**
   * 주문이 체결될 때까지 주기적으로 상태를 확인합니다.
   */
  private async pollOrderStatus(
    cycleId: string,
    exchange: ExchangeType,
    orderId: string,
  ): Promise<Order> {
    const startTime = Date.now();
    this.logger.log(
      `[POLLING] Start polling for order ${orderId} on ${exchange}. Timeout: ${this.ORDER_TIMEOUT_MS}ms`,
    );

    while (Date.now() - startTime < this.ORDER_TIMEOUT_MS) {
      try {
        const order = await this.exchangeService.getOrder(exchange, orderId);
        if (order.status === 'filled') {
          this.logger.log(`[POLLING] Order ${orderId} filled.`);
          return order;
        }
        if (order.status === 'canceled') {
          throw new Error(`Order ${orderId} was canceled.`);
        }
        // 미체결 상태면 잠시 대기 후 다시 시도
        await delay(this.POLLING_INTERVAL_MS);
      } catch (e) {
        this.logger.warn(
          `[POLLING] Error while polling order ${orderId}: ${e.message}. Retrying...`,
        );
        await delay(this.POLLING_INTERVAL_MS);
      }
    }
    throw new Error(
      `Polling for order ${orderId} timed out after ${this.ORDER_TIMEOUT_MS}ms.`,
    );
  }

  /**
   * 입금이 완료될 때까지 주기적으로 잔고를 확인합니다.
   */
  private async pollDepositConfirmation(
    cycleId: string,
    exchange: ExchangeType,
    symbol: string,
    expectedAmount: number,
  ): Promise<void> {
    const startTime = Date.now();
    this.logger.log(
      `[POLLING] Start polling for deposit of ${expectedAmount} ${symbol} on ${exchange}. Timeout: ${this.DEPOSIT_TIMEOUT_MS}ms`,
    );

    // 1. 입금 확인 전 현재 잔고 조회
    const initialBalances = await this.exchangeService.getBalances(exchange);
    const initialBalance =
      initialBalances.find(
        (b) => b.currency.toUpperCase() === symbol.toUpperCase(),
      )?.available || 0;

    // 2. 잔고가 증가할 때까지 대기
    while (Date.now() - startTime < this.DEPOSIT_TIMEOUT_MS) {
      try {
        const currentBalances =
          await this.exchangeService.getBalances(exchange);
        const currentBalance =
          currentBalances.find(
            (b) => b.currency.toUpperCase() === symbol.toUpperCase(),
          )?.available || 0;

        // 출금 수수료 등을 감안하여, 예상 수량의 99.9% 이상만 들어오면 성공으로 간주
        if (currentBalance >= initialBalance + expectedAmount * 0.999) {
          this.logger.log(
            `[POLLING] Deposit of ${symbol} confirmed. New balance: ${currentBalance}`,
          );
          return;
        }
        await delay(this.POLLING_INTERVAL_MS * 5); // 입금 확인은 더 긴 간격으로 폴링
      } catch (e) {
        this.logger.warn(
          `[POLLING] Error while polling deposit for ${symbol}: ${e.message}. Retrying...`,
        );
        await delay(this.POLLING_INTERVAL_MS * 5);
      }
    }
    throw new Error(
      `Polling for deposit of ${symbol} timed out after ${this.DEPOSIT_TIMEOUT_MS}ms.`,
    );
  }
}
