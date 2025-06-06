// src/common/strategy-low.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ArbitrageRecordService } from '../db/arbitrage-record.service';
import { ExchangeService, ExchangeType } from './exchange.service';
import { Order } from './exchange.interface';

// 유틸리티 함수: 지정된 시간(ms)만큼 대기
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class StrategyLowService {
  private readonly logger = new Logger(StrategyLowService.name);

  // 폴링 관련 설정
  private readonly POLLING_INTERVAL_MS = 3000; // 3초
  private readonly ORDER_TIMEOUT_MS = 180000; // 3분
  private readonly DEPOSIT_TIMEOUT_MS = 600000; // 10분

  constructor(
    private readonly exchangeService: ExchangeService,
    private readonly arbitrageRecordService: ArbitrageRecordService,
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
      const filledBuyOrder = await this.pollOrderStatus(
        cycleId,
        'upbit',
        buyOrder.id,
      );
      await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
        status: 'LP_BOUGHT',
        lowPremiumBuyTxId: filledBuyOrder.id,
      });
      this.logger.log(`[STRATEGY_LOW] Upbit buy order for ${symbol} filled.`);

      // 2. 바이낸스로 출금
      const { address: binanceAddress, tag: binanceTag } =
        await this.exchangeService.getDepositAddress('binance', symbol);
      const withdrawalResult = await this.exchangeService.withdraw(
        'upbit',
        symbol,
        binanceAddress,
        filledBuyOrder.filledAmount,
        binanceTag,
      );
      await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
        status: 'LP_WITHDRAWN',
        lowPremiumWithdrawTxId: withdrawalResult.id,
      });
      this.logger.log(
        `[STRATEGY_LOW] Withdrawal from Upbit to Binance initiated.`,
      );

      // 3. 바이낸스 입금 확인
      await this.pollDepositConfirmation(
        cycleId,
        'binance',
        symbol,
        filledBuyOrder.filledAmount,
      );
      await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
        status: 'LP_DEPOSITED',
      });
      this.logger.log(`[STRATEGY_LOW] Deposit to Binance confirmed.`);

      // 4. 바이낸스 매도
      const sellOrder = await this.exchangeService.createOrder(
        'binance',
        symbol,
        'limit',
        'sell',
        filledBuyOrder.filledAmount,
        binancePrice,
      );
      const filledSellOrder = await this.pollOrderStatus(
        cycleId,
        'binance',
        sellOrder.id,
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
      const order = await this.exchangeService.getOrder(exchange, orderId);
      if (order.status === 'filled') {
        this.logger.log(`[POLLING] Order ${orderId} filled.`);
        return order;
      }
      if (order.status === 'canceled') {
        throw new Error(`Order ${orderId} was canceled.`);
      }
      await delay(this.POLLING_INTERVAL_MS);
    }
    throw new Error(
      `Polling for order ${orderId} timed out after ${this.ORDER_TIMEOUT_MS}ms.`,
    );
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

      if (currentBalance >= initialBalance + expectedAmount * 0.999) {
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
