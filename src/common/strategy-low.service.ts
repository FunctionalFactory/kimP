// src/common/strategy-low.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ArbitrageRecordService } from '../db/arbitrage-record.service';
import { ExchangeService, ExchangeType } from './exchange.service';
import { Order, OrderSide } from './exchange.interface';
import { ConfigService } from '@nestjs/config'; // ⭐️ ConfigService import 추가
import axios from 'axios';
import { TelegramService } from './telegram.service';
import { WithdrawalConstraintService } from './withdrawal-constraint.service';

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
    private readonly telegramService: TelegramService, // TelegramService 주입
    private readonly withdrawalConstraintService: WithdrawalConstraintService,
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

    let shortPositionAmount = 0;
    let transferredToFutures = false; // 🔥 추가: 선물로 이체했는지 추적
    let transferAmount = 0; // �� 추가: 이체한 금액 추적

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

      try {
        const requiredMarginUSDT = filledBuyOrder.filledAmount * binancePrice;
        transferAmount = requiredMarginUSDT; // 🔥 이체 금액 기록

        this.logger.log(
          `[HEDGE_LP] 숏 포지션 증거금 확보를 위해 현물 지갑에서 선물 지갑으로 ${requiredMarginUSDT.toFixed(2)} USDT 이체를 시도합니다.`,
        );

        // internalTransfer 함수를 사용하여 자산 이체
        await this.exchangeService.internalTransfer(
          'binance',
          'USDT',
          requiredMarginUSDT,
          'SPOT', // From: 현물(Spot) 지갑
          'UMFUTURE', // To: 선물(USDⓈ-M Futures) 지갑
        );
        transferredToFutures = true; // 🔥 이체 완료 표시
        await delay(2000); // 이체 후 반영될 때까지 잠시 대기

        this.logger.log(
          `[HEDGE_LP] 증거금 이체 완료. ${symbol} 1x 숏 포지션 진입을 시작합니다...`,
        );
        shortPositionAmount = filledBuyOrder.filledAmount; // 헷지할 수량 기록

        const shortOrder = await this.exchangeService.createFuturesOrder(
          'binance',
          symbol,
          'sell', // 숏 포지션 진입
          'market',
          shortPositionAmount,
        );

        this.logger.log(
          `[HEDGE_LP] 숏 포지션 진입 성공. TxID: ${shortOrder.id}`,
        );
        await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
          lp_short_entry_tx_id: shortOrder.id, // DB에 기록
        });
      } catch (hedgeError) {
        this.logger.error(
          `[HEDGE_LP_FAIL] 선물 증거금 이체에 실패했습니다: ${hedgeError.message}`,
        );
        await this.telegramService.sendMessage(
          `🚨 [긴급_LP] 사이클 ${cycleId}의 선물 증거금 이체 실패! 확인 필요!`,
        );
        // throw hedgeError; // 증거금 확보 실패는 심각한 문제이므로 사이클 중단
      }

      // 2. 바이낸스로 출금
      const { address: binanceAddress, tag: binanceTag } =
        await this.exchangeService.getDepositAddress('binance', symbol);

      const { net_type: upbitNetType } =
        await this.exchangeService.getDepositAddress('upbit', symbol);

      const amountToWithdraw = filledBuyOrder.filledAmount;
      const adjustedAmountToWithdraw =
        this.withdrawalConstraintService.adjustWithdrawalAmount(
          symbol,
          amountToWithdraw,
        );

      this.logger.log(
        `[STRATEGY_LOW] 출금 수량 조정: ${amountToWithdraw} → ${adjustedAmountToWithdraw} ${symbol}`,
      );

      const withdrawalResult = await this.exchangeService.withdraw(
        'upbit',
        symbol,
        binanceAddress,
        adjustedAmountToWithdraw.toString(),
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
      const filledSellOrder = await this.aggressiveSellOnBinance(
        cycleId,
        symbol,
        sellAmount,
      );

      await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
        status: 'LP_SOLD',
      });
      this.logger.log(
        `[STRATEGY_LOW] Binance sell order for ${symbol} filled.`,
      );

      try {
        this.logger.log(
          `[HEDGE_LP] 현물 매도 완료. ${symbol} 숏 포지션 종료를 시작합니다...`,
        );

        const closeShortOrder = await this.exchangeService.createFuturesOrder(
          'binance',
          symbol,
          'buy', // 숏 포지션 종료는 'BUY'
          'market',
          shortPositionAmount, // 진입했던 수량 그대로 청산
        );

        this.logger.log(
          `[HEDGE_LP] 숏 포지션 종료 성공. TxID: ${closeShortOrder.id}`,
        );
        if (transferredToFutures) {
          await this.returnFundsToSpot(cycleId, transferAmount);
        }
        await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
          lp_short_close_tx_id: closeShortOrder.id, // DB에 기록
        });
      } catch (hedgeError) {
        if (transferredToFutures) {
          await this.returnFundsToSpot(cycleId, transferAmount, true);
        }
        this.logger.error(
          `[HEDGE_LP_FAIL] 숏 포지션 종료에 실패했습니다: ${hedgeError.message}`,
        );
        await this.telegramService.sendMessage(
          `🚨 [긴급_LP] 사이클 ${cycleId}의 ${symbol} 숏 포지션 종료 실패! 수동 청산 필요!`,
        );
      }

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
      if (transferredToFutures) {
        await this.returnFundsToSpot(cycleId, transferAmount, true);
      }

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
  // �� 추가: 자금 반환 로직을 별도 메서드로 분리
  private async returnFundsToSpot(
    cycleId: string,
    amount: number,
    isErrorCase: boolean = false,
  ): Promise<void> {
    const context = isErrorCase ? '[ERROR_RETURN]' : '[HEDGE_LP]';
    try {
      const futuresBalances = await this.exchangeService.getFuturesBalances(
        'binance',
        'UMFUTURE',
      );
      const futuresUsdtBalance =
        futuresBalances.find((b) => b.currency === 'USDT')?.available || 0;

      this.logger.log(
        `${context} 선물 지갑 USDT 잔고: ${futuresUsdtBalance.toFixed(6)} USDT`,
      );

      const actualReturnAmount = Math.min(futuresUsdtBalance, amount);

      if (actualReturnAmount <= 0) {
        this.logger.warn(
          `${context} 선물 지갑에 반환할 USDT가 없습니다. (잔고: ${futuresUsdtBalance.toFixed(6)} USDT)`,
        );
        return;
      }

      this.logger.log(
        `${context} 선물 지갑에서 현물 지갑으로 ${actualReturnAmount.toFixed(6)} USDT를 반환합니다...`,
      );

      await this.exchangeService.internalTransfer(
        'binance',
        'USDT',
        actualReturnAmount,
        'UMFUTURE', // From: 선물 지갑
        'SPOT', // To: 현물 지갑
      );

      this.logger.log(`${context} 현물 지갑으로 자금 반환 완료.`);
      if (actualReturnAmount < amount) {
        const difference = amount - actualReturnAmount;
        this.logger.warn(
          `${context} 반환 금액이 요청 금액보다 적습니다. 차이: ${difference.toFixed(6)} USDT (수수료/가격변동)`,
        );
      }
    } catch (returnError) {
      this.logger.error(
        `${context} 현물 지갑으로 자금 반환 실패: ${returnError.message}`,
      );
      await this.telegramService.sendMessage(
        `⚠️ [자금 반환 실패] 사이클 ${cycleId}의 현물 지갑 자금 반환에 실패했습니다. 수동 확인 필요.`,
      );
    }
  }

  private async aggressiveSellOnBinance(
    cycleId: string,
    symbol: string,
    amountToSell: number,
  ): Promise<Order> {
    this.logger.log(
      `[AGGRESSIVE_SELL_BINANCE] ${amountToSell} ${symbol} 전량 매도를 시작합니다.`,
    );
    const market = `${symbol.toUpperCase()}USDT`;

    let lastOrderPrice = 0; // �� 추가: 마지막 주문 가격 추적

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        this.logger.verbose(
          `[AGGRESSIVE_SELL_BINANCE] 현재가 조회를 시도합니다...`,
        );
        const tickerResponse = await axios.get(
          `https://api.binance.com/api/v3/ticker/price?symbol=${market}`,
        );
        const currentPrice = parseFloat(tickerResponse.data.price);

        if (!currentPrice) {
          this.logger.warn(
            `[AGGRESSIVE_SELL_BINANCE] 현재가 조회 실패. 5초 후 재시도합니다.`,
          );
          await delay(5000);
          continue;
        }

        if (lastOrderPrice === currentPrice) {
          this.logger.log(
            `[AGGRESSIVE_SELL_BINANCE] 현재가(${currentPrice})가 마지막 주문가(${lastOrderPrice})와 동일합니다. 5초 후 재확인합니다.`,
          );
          await delay(5000);
          continue;
        }

        //매도 시도 전 실제 잔고 재확인
        const binanceBalances =
          await this.exchangeService.getBalances('binance');
        const actualBalance =
          binanceBalances.find((b) => b.currency === symbol.toUpperCase())
            ?.available || 0;

        this.logger.log(
          `[AGGRESSIVE_SELL_BINANCE] 실제 ${symbol} 잔고: ${actualBalance}, 매도 시도 수량: ${amountToSell}`,
        );

        const adjustedAmountToSell = Math.min(actualBalance, amountToSell);

        if (adjustedAmountToSell <= 0) {
          this.logger.warn(
            `[AGGRESSIVE_SELL_BINANCE] ${symbol} 잔고가 없습니다. 매도를 중단합니다.`,
          );
          throw new Error(`No ${symbol} balance available for selling.`);
        }

        if (adjustedAmountToSell < amountToSell) {
          this.logger.warn(
            `[AGGRESSIVE_SELL_BINANCE] 실제 잔고(${actualBalance})가 요청 수량(${amountToSell})보다 적습니다. 조정된 수량(${adjustedAmountToSell})으로 매도합니다.`,
          );
        }

        this.logger.log(
          `[AGGRESSIVE_SELL_BINANCE] 현재가: ${currentPrice} USDT. 지정가 매도를 시도합니다.`,
        );
        const sellOrder = await this.exchangeService.createOrder(
          'binance',
          symbol,
          'limit',
          'sell',
          adjustedAmountToSell,
          currentPrice,
        );

        lastOrderPrice = currentPrice;

        const startTime = Date.now();
        while (Date.now() - startTime < 10000) {
          const orderStatus = await this.exchangeService.getOrder(
            'binance',
            sellOrder.id,
            symbol,
          );
          if (orderStatus.status === 'filled') {
            this.logger.log(
              `[AGGRESSIVE_SELL_BINANCE] 매도 성공! Order ID: ${orderStatus.id}, 체결 수량: ${orderStatus.filledAmount}`,
            );
            return orderStatus;
          }
          await delay(2000);
        }

        this.logger.log(
          `[AGGRESSIVE_SELL_BINANCE] 10초 내 미체결. 주문 취소 후 재시도. Order ID: ${sellOrder.id}`,
        );
        await this.exchangeService.cancelOrder('binance', sellOrder.id, symbol);
      } catch (error) {
        const errorMessage = error.message.toLowerCase();
        // 재시도가 무의미한 특정 에러 키워드들
        const fatalErrors = [
          'insufficient funds',
          'invalid access key',
          'minimum total',
          'no balance available', // �� 추가: 잔고 부족 에러
        ];
        if (fatalErrors.some((keyword) => errorMessage.includes(keyword))) {
          this.logger.error(
            `[AGGRESSIVE_SELL_BINANCE] 치명적 오류 발생, 매도를 중단합니다: ${error.message}`,
          );
          // 여기서 에러를 다시 던져서 handleLowPremiumFlow의 메인 catch 블록으로 넘김
          throw error;
        }
        this.logger.error(
          `[AGGRESSIVE_SELL_BINANCE] 매도 시도 중 오류: ${error.message}. 5초 후 재시도합니다.`,
        );
      }
      await delay(5000);
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
