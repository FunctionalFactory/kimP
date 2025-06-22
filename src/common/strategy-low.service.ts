// src/common/strategy-low.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ArbitrageRecordService } from '../db/arbitrage-record.service';
import { ExchangeService, ExchangeType } from './exchange.service';
import { Order, OrderSide } from './exchange.interface';
import { ConfigService } from '@nestjs/config'; // ⭐️ ConfigService import 추가

// 유틸리티 함수: 지정된 시간(ms)만큼 대기
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class StrategyLowService {
  private readonly logger = new Logger(StrategyLowService.name);

  // 폴링 관련 설정
  private readonly POLLING_INTERVAL_MS = 3000; // 3초
  private readonly DEPOSIT_TIMEOUT_MS = 600000; // 10분

  private readonly ORDER_RETRY_LIMIT = 3; // 최대 재주문 횟수
  private readonly ORDER_POLL_TIMEOUT_MS = 30000; // 각 주문의 폴링 타임아웃 (30초)
  private readonly PRICE_ADJUSTMENT_FACTOR = 0.0005; // 가격 조정 비율 (0.05%)

  constructor(
    private readonly exchangeService: ExchangeService,
    private readonly arbitrageRecordService: ArbitrageRecordService,
    private readonly configService: ConfigService,
  ) {}

  async handleLowPremiumFlow(
    symbol: string,
    upbitPrice: number,
    binancePrice: number,
    rate: number,
    cycleId: string,
    investmentKRW: number,
  ): Promise<void> {
    this.logger.log(`[STRATEGY_LOW] Starting REAL trade for cycle ${cycleId}`);

    try {
      this.logger.log(
        `[STRATEGY_LOW] 사전 점검: 업비트에서 사용 가능한 KRW 잔고를 확인합니다...`,
      );
      const upbitBalances = await this.exchangeService.getBalances('upbit');
      const krwBalance =
        upbitBalances.find((b) => b.currency === 'KRW')?.available || 0;

      if (krwBalance < investmentKRW) {
        throw new Error(
          `업비트 KRW 잔고 부족. 필요 금액: ${investmentKRW.toFixed(0)}, 현재 잔고: ${krwBalance.toFixed(0)}`,
        );
      }
      this.logger.log(`[STRATEGY_LOW] 잔고 확인 완료. 거래를 계속합니다.`);

      // 0. 사전 안전 점검
      const upbitWalletStatus = await this.exchangeService.getWalletStatus(
        'upbit',
        symbol,
      );
      if (!upbitWalletStatus.canWithdraw) {
        throw new Error(`Upbit wallet for ${symbol} has withdrawal disabled.`);
      }
      const binanceWalletStatus = await this.exchangeService.getWalletStatus(
        'binance',
        symbol,
      );
      if (!binanceWalletStatus.canDeposit) {
        throw new Error(`Binance wallet for ${symbol} has deposit disabled.`);
      }
      this.logger.log(`[STRATEGY_LOW] Wallet status check OK for ${symbol}`);

      // 1. 업비트 매수
      const buyAmount = investmentKRW / upbitPrice;
      const buyOrder = await this.exchangeService.createOrder(
        'upbit',
        symbol,
        'limit',
        'buy',
        buyAmount,
        upbitPrice,
      );

      const upbitMode = this.configService.get('UPBIT_MODE');
      let filledBuyOrder: Order;

      if (upbitMode === 'SIMULATION') {
        this.logger.log('[SIMULATION] Skipping Upbit buy order polling.');
        filledBuyOrder = buyOrder;
      } else {
        filledBuyOrder = await this.pollOrderStatus(
          cycleId,
          'upbit',
          buyOrder.id,
          symbol,
          upbitPrice,
          'buy',
          buyAmount,
        );
      }

      await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
        status: 'LP_BOUGHT',
        lowPremiumBuyTxId: filledBuyOrder.id,
      });
      this.logger.log(`[STRATEGY_LOW] Upbit buy order for ${symbol} filled.`);

      // 2. 바이낸스로 출금
      const { address: binanceAddress, tag: binanceTag } =
        await this.exchangeService.getDepositAddress('binance', symbol);

      const { net_type: upbitNetType } =
        await this.exchangeService.getDepositAddress('upbit', symbol);

      const withdrawalResult = await this.exchangeService.withdraw(
        'upbit',
        symbol,
        binanceAddress,
        filledBuyOrder.filledAmount.toString(),
        binanceTag,
        upbitNetType,
      );
      await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
        status: 'LP_WITHDRAWN',
        lowPremiumWithdrawTxId: withdrawalResult.id,
      });
      this.logger.log(
        `[STRATEGY_LOW] Withdrawal from Upbit to Binance initiated.`,
      );

      // 3. 바이낸스 입금 확인
      const binanceMode = this.configService.get('BINANCE_MODE');
      if (binanceMode === 'SIMULATION') {
        this.logger.log(
          '[SIMULATION] Skipping Binance deposit confirmation polling.',
        );
        await delay(2000); // 시뮬레이션 모드에서는 가상 딜레이만 줌
      } else {
        await this.pollDepositConfirmation(
          cycleId,
          'binance',
          symbol,
          filledBuyOrder.filledAmount,
        );
      }
      await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
        status: 'LP_DEPOSITED',
      });
      this.logger.log(`[STRATEGY_LOW] Deposit to Binance confirmed.`);

      // 4. 바이낸스 매도
      const sellAmount = filledBuyOrder.filledAmount; // 판매할 수량
      const sellOrder = await this.exchangeService.createOrder(
        'binance',
        symbol,
        'limit',
        'sell',
        sellAmount,
        binancePrice,
      );
      const filledSellOrder = await this.pollOrderStatus(
        cycleId,
        'binance',
        sellOrder.id,
        symbol,
        binancePrice,
        'sell',
        sellAmount,
      );
      await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
        status: 'LP_SOLD',
      });
      this.logger.log(
        `[STRATEGY_LOW] Binance sell order for ${symbol} filled.`,
      );

      // 5. 최종 사이클 결과 계산 및 DB 업데이트
      const existingCycle =
        await this.arbitrageRecordService.getArbitrageCycle(cycleId);
      if (!existingCycle)
        throw new Error('Could not find cycle data for final calculation.');

      const highPremiumProfit = Number(
        existingCycle.highPremiumNetProfitKrw || 0,
      );
      const lowPremiumSellUsd =
        filledSellOrder.filledAmount * filledSellOrder.price -
        (filledSellOrder.fee.cost || 0);
      const lowPremiumNetProfitKrw = lowPremiumSellUsd * rate - investmentKRW; // TODO: 전송 수수료 추가 계산 필요
      const totalNetProfitKrw = highPremiumProfit + lowPremiumNetProfitKrw;
      const totalInvestmentKrw = Number(existingCycle.initialInvestmentKrw);
      const totalNetProfitPercent =
        (totalNetProfitKrw / totalInvestmentKrw) * 100;

      await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
        status: 'COMPLETED',
        endTime: new Date(),
        lowPremiumSymbol: symbol,
        lowPremiumNetProfitKrw: lowPremiumNetProfitKrw,
        lowPremiumNetProfitUsd: lowPremiumNetProfitKrw / rate,
        totalNetProfitKrw,
        totalNetProfitPercent,
        totalNetProfitUsd: totalNetProfitKrw / rate,
      });
      this.logger.log(`✅ [STRATEGY_LOW] Cycle ${cycleId} fully COMPLETED.`);
    } catch (error) {
      this.logger.error(
        `[STRATEGY_LOW] CRITICAL ERROR during cycle ${cycleId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
        status: 'FAILED',
        errorDetails: `Low Premium Leg Failed: ${(error as Error).message}`,
      });
    }
  }

  // 주문 체결 폴링 로직
  // 주문 체결 폴링 로직을 '호가 추적' 기능이 포함된 새 로직으로 교체
  private async pollOrderStatus(
    cycleId: string,
    exchange: ExchangeType,
    initialOrderId: string,
    symbol: string,
    initialPrice: number,
    side: OrderSide,
    amount: number,
  ): Promise<Order> {
    let currentOrderId = initialOrderId;
    let currentPrice = initialPrice;

    for (let attempt = 1; attempt <= this.ORDER_RETRY_LIMIT; attempt++) {
      const startTime = Date.now();
      this.logger.log(
        `[POLLING ATTEMPT #${attempt}] Start polling for order ${currentOrderId}. Price: ${currentPrice}`,
      );

      while (Date.now() - startTime < this.ORDER_POLL_TIMEOUT_MS) {
        try {
          const order = await this.exchangeService.getOrder(
            exchange,
            currentOrderId,
            symbol,
          );
          if (order.status === 'filled') {
            this.logger.log(
              `[POLLING] Order ${currentOrderId} filled on attempt #${attempt}.`,
            );
            return order;
          }
          if (order.status === 'canceled') {
            throw new Error(`Order ${currentOrderId} was canceled.`);
          }
          await delay(this.POLLING_INTERVAL_MS);
        } catch (e) {
          this.logger.warn(
            `[POLLING] Error polling order ${currentOrderId}: ${e.message}. Retrying...`,
          );
          await delay(this.POLLING_INTERVAL_MS);
        }
      }

      if (attempt < this.ORDER_RETRY_LIMIT) {
        this.logger.warn(
          `[RETRY] Order ${currentOrderId} timed out. Canceling and re-submitting...`,
        );
        try {
          await this.exchangeService.cancelOrder(
            exchange,
            currentOrderId,
            symbol,
          );
          currentPrice =
            side === 'buy'
              ? currentPrice * (1 + this.PRICE_ADJUSTMENT_FACTOR)
              : currentPrice * (1 - this.PRICE_ADJUSTMENT_FACTOR);

          const newOrder = await this.exchangeService.createOrder(
            exchange,
            symbol,
            'limit',
            side,
            amount,
            currentPrice,
          );
          currentOrderId = newOrder.id;
          this.logger.log(
            `[RETRY] New order ${currentOrderId} placed at new price ${currentPrice}.`,
          );
        } catch (error) {
          this.logger.error(
            `[RETRY] Failed to cancel or re-submit order: ${error.message}`,
          );
          throw error;
        }
      }
    }

    this.logger.error(
      `[FINAL TIMEOUT] Order failed to fill after ${this.ORDER_RETRY_LIMIT} attempts. Canceling final order ${currentOrderId}.`,
    );
    try {
      await this.exchangeService.cancelOrder(exchange, currentOrderId, symbol);
    } catch (finalCancelError) {
      this.logger.error(
        `[FINAL TIMEOUT] CRITICAL: Failed to cancel final order ${currentOrderId}: ${finalCancelError.message}`,
      );
    }

    throw new Error(`Order for ${symbol} failed to fill after all retries.`);
  }

  // 입금 확인 폴링 로직
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

    const initialBalances = await this.exchangeService.getBalances(exchange);
    const initialBalance =
      initialBalances.find(
        (b) => b.currency.toUpperCase() === symbol.toUpperCase(),
      )?.available || 0;

    while (Date.now() - startTime < this.DEPOSIT_TIMEOUT_MS) {
      const currentBalances = await this.exchangeService.getBalances(exchange);
      const currentBalance =
        currentBalances.find(
          (b) => b.currency.toUpperCase() === symbol.toUpperCase(),
        )?.available || 0;

      if (currentBalance >= initialBalance + expectedAmount * 0.995) {
        this.logger.log(
          `[POLLING] Deposit of ${symbol} confirmed. New balance: ${currentBalance}`,
        );
        return;
      }
      await delay(this.POLLING_INTERVAL_MS * 5);
    }
    throw new Error(
      `Polling for deposit of ${symbol} timed out after ${this.DEPOSIT_TIMEOUT_MS}ms.`,
    );
  }
}
