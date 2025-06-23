// src/common/strategy-high.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ArbitrageRecordService } from '../db/arbitrage-record.service';
import { ExchangeService, ExchangeType } from './exchange.service';
import { Order, OrderSide } from './exchange.interface';
import { ConfigService } from '@nestjs/config'; // ⭐️ ConfigService import 추가
import axios from 'axios';
import { BinanceService } from 'src/binance/binance.service'; // ◀️ import 추가
import { TelegramService } from './telegram.service';

// 유틸리티 함수: 지정된 시간(ms)만큼 대기
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class StrategyHighService {
  private readonly logger = new Logger(StrategyHighService.name);

  // 폴링 관련 설정 (나중에 .env로 옮기는 것을 추천)
  private readonly POLLING_INTERVAL_MS = 3000; // 3초
  private readonly DEPOSIT_TIMEOUT_MS = 600000; // 10분
  private readonly ORDER_RETRY_LIMIT = 3; // 최대 재주문 횟수
  private readonly ORDER_POLL_TIMEOUT_MS = 30000; // 각 주문의 폴링 타임아웃 (30초)
  private readonly PRICE_ADJUSTMENT_FACTOR = 0.0005; // 가격 조정 비율 (0.05%)

  constructor(
    private readonly exchangeService: ExchangeService,
    private readonly arbitrageRecordService: ArbitrageRecordService,
    private readonly configService: ConfigService,
    private readonly binanceService: BinanceService, // ◀️ 주입 추가
    private readonly telegramService: TelegramService, // TelegramService 주입 추가
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

    let shortPositionAmount = 0;

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

      // 1. 바이낸스 매수 전, 현물 지갑 잔고 확인
      let binanceBalances = await this.exchangeService.getBalances('binance');
      const usdtBalance =
        binanceBalances.find((b) => b.currency === 'USDT')?.available || 0;

      // 매수하려는 금액(actualInvestmentUSDT)보다 현물 지갑 잔고가 부족할 경우
      if (usdtBalance < actualInvestmentUSDT) {
        const amountToTransfer = actualInvestmentUSDT - usdtBalance;
        this.logger.warn(
          `[STRATEGY_HIGH] 현물 지갑 USDT 부족. 선물 지갑에서 ${amountToTransfer} USDT를 가져옵니다...`,
        );
        // 선물 -> 현물로 부족한 만큼 이체
        await this.exchangeService.internalTransfer(
          'binance',
          'USDT',
          amountToTransfer,
          'UMFUTURE',
          'SPOT',
        );
        // 잠시 대기 후 로직 계속
        await delay(2000);
      }

      // 1. 바이낸스 매수
      // TODO: getOrderBook으로 호가창 확인 후, 지정가(limit)로 주문 가격 결정
      const exchangeTickerForInfo =
        this.binanceService.getExchangeTicker(symbol);
      const market = `${exchangeTickerForInfo}USDT`;

      // 바이낸스 거래 규칙(Exchange Info) 조회
      this.logger.log(
        `[STRATEGY_HIGH] 바이낸스 거래 규칙(stepSize) 조회를 위해 exchangeInfo를 호출합니다: ${market}`,
      );
      const exchangeInfoRes = await axios.get(
        'https://api.binance.com/api/v3/exchangeInfo',
      );
      const symbolInfo = exchangeInfoRes.data.symbols.find(
        (s: any) => s.symbol === market,
      );

      if (!symbolInfo) {
        throw new Error(`Could not find exchange info for symbol ${market}`);
      }

      const lotSizeFilter = symbolInfo.filters.find(
        (f: any) => f.filterType === 'LOT_SIZE',
      );

      if (!lotSizeFilter) {
        throw new Error(`Could not find LOT_SIZE filter for ${market}`);
      }

      // 규칙에서 quoteAsset(USDT)의 허용 정밀도(소수점 자릿수)를 가져옵니다.
      const quotePrecision = symbolInfo.quoteAssetPrecision;

      // 투자할 총액(USDT)을 허용된 정밀도에 맞게 조정합니다.
      const adjustedInvestmentUSDT = parseFloat(
        actualInvestmentUSDT.toFixed(quotePrecision),
      );

      const buyAmount = adjustedInvestmentUSDT / binancePrice;

      // stepSize에 맞춰 수량 정밀도 조정
      const stepSize = parseFloat(lotSizeFilter.stepSize);
      const adjustedBuyAmount = Math.floor(buyAmount / stepSize) * stepSize;

      this.logger.log(
        `[STRATEGY_HIGH] 수량 정밀도 조정: Raw: ${buyAmount} -> Adjusted: ${adjustedBuyAmount}`,
      );

      if (adjustedBuyAmount <= 0) {
        throw new Error(
          `조정된 매수 수량(${adjustedBuyAmount})이 0보다 작거나 같아 주문할 수 없습니다.`,
        );
      }

      this.logger.log(
        `[STRATEGY_HIGH] Placing LIMIT buy order for ${adjustedBuyAmount} ${symbol} at ${binancePrice} USDT`,
      );

      const buyOrder = await this.exchangeService.createOrder(
        'binance',
        symbol,
        'limit',
        'buy',
        adjustedBuyAmount,
        binancePrice,
      );

      const binanceMode = this.configService.get('BINANCE_MODE');
      let filledBuyOrder: Order;

      if (binanceMode === 'SIMULATION') {
        this.logger.log('[SIMULATION] Skipping Binance buy order polling.');
        filledBuyOrder = buyOrder;
      } else {
        filledBuyOrder = await this.pollOrderStatus(
          cycleId,
          'binance',
          buyOrder.id,
          symbol,
          binancePrice, // 초기 가격 전달
          'buy', // 주문 방향 전달
          adjustedBuyAmount, // 재주문 시 사용할 수량 전달
        );
      }

      await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
        status: 'HP_BOUGHT',
        highPremiumBuyTxId: filledBuyOrder.id,
      });
      this.logger.log(
        `[STRATEGY_HIGH] Binance buy order for ${symbol} filled.`,
      );

      try {
        this.logger.log(
          `[HEDGE] 현물 매수 완료. ${symbol} 1x 숏 포지션 진입을 시작합니다...`,
        );
        shortPositionAmount = filledBuyOrder.filledAmount; // 헷지할 수량 기록

        const shortOrder = await this.exchangeService.createFuturesOrder(
          'binance',
          symbol,
          'sell', // 숏 포지션이므로 'SELL'
          'market', // 시장가로 즉시 진입
          shortPositionAmount,
        );

        this.logger.log(`[HEDGE] 숏 포지션 진입 성공. TxID: ${shortOrder.id}`);
        await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
          hp_short_entry_tx_id: shortOrder.id, // DB에 숏 포지션 주문 ID 기록
        });
      } catch (hedgeError) {
        this.logger.error(
          `[HEDGE_FAIL] 숏 포지션 진입에 실패했습니다: ${hedgeError.message}`,
        );
        // 헷지에 실패했더라도 일단 플로우는 계속 진행하되, 관리자에게 알림을 보내는 등의 추가 조치 필요
        await this.telegramService.sendMessage(
          `🚨 [긴급] 사이클 ${cycleId}의 ${symbol} 헷지 포지션 진입에 실패했습니다. 즉시 확인 필요!`,
        );
        // 에러를 다시 던져서 사이클을 실패 처리할 수도 있음
        // throw hedgeError;
      }

      this.logger.log(
        `[STRATEGY_HIGH] 교차 검증: 매수 후 실제 바이낸스 잔고를 확인합니다...`,
      );
      // 바이낸스 내부 시스템에 잔고가 반영될 때까지 아주 잠시(1~2초) 기다려줍니다.
      await new Promise((resolve) => setTimeout(resolve, 2000));

      binanceBalances = await this.exchangeService.getBalances('binance');
      const coinBalance =
        binanceBalances.find((b) => b.currency === symbol.toUpperCase())
          ?.available || 0;

      // API 응답의 체결 수량과 실제 지갑의 보유 수량이 거의 일치하는지 확인합니다. (네트워크 수수료 등 감안 99.9%)
      const successThreshold = 0.998; // 0.2%의 오차(수수료 등)를 허용
      if (coinBalance < filledBuyOrder.filledAmount * successThreshold) {
        throw new Error(
          `매수 후 잔고 불일치. API 응답상 체결 수량: ${filledBuyOrder.filledAmount}, 실제 지갑 보유 수량: ${coinBalance}`,
        );
      }
      this.logger.log(
        `[STRATEGY_HIGH] 잔고 확인 완료. 실제 보유 수량: ${coinBalance} ${symbol.toUpperCase()}`,
      );

      // 2. 업비트로 출금
      const { address: upbitAddress, tag: upbitTag } =
        await this.exchangeService.getDepositAddress('upbit', symbol);

      this.logger.log(
        `[STRATEGY_HIGH] 바이낸스에서 ${symbol.toUpperCase()} 출금 수수료를 조회합니다...`,
      );
      const withdrawalChance = await this.exchangeService.getWithdrawalChance(
        'binance',
        symbol,
      );
      const withdrawalFee = withdrawalChance.fee;
      this.logger.log(
        `[STRATEGY_HIGH] 조회된 출금 수수료: ${withdrawalFee} ${symbol.toUpperCase()}`,
      );

      const amountToWithdraw = coinBalance - withdrawalFee;

      if (amountToWithdraw <= 0) {
        throw new Error(
          `보유 잔고(${coinBalance})가 출금 수수료(${withdrawalFee})보다 작거나 같아 출금할 수 없습니다.`,
        );
      }

      // 출금 수량 또한 정밀도 조정이 필요할 수 있습니다. 여기서는 간단히 처리합니다.
      const adjustedAmountToWithdraw = parseFloat(amountToWithdraw.toFixed(8));
      this.logger.log(
        `[STRATEGY_HIGH] 수수료 차감 후 실제 출금할 수량: ${adjustedAmountToWithdraw}`,
      );
      // 실제 체결된 수량으로 출금 요청
      const withdrawalResult = await this.exchangeService.withdraw(
        'binance',
        symbol,
        upbitAddress,
        adjustedAmountToWithdraw.toString(), // ◀️ 수수료를 제외한 금액으로 출금
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
      const upbitMode = this.configService.get('UPBIT_MODE');
      if (upbitMode === 'SIMULATION') {
        this.logger.log(
          '[SIMULATION] Skipping Upbit deposit confirmation polling.',
        );
        await delay(2000); // 시뮬레이션 모드에서는 가상 딜레이만 줌
      } else {
        await this.pollDepositConfirmation(
          cycleId,
          'upbit',
          symbol,
          adjustedAmountToWithdraw,
        );
      }

      await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
        status: 'HP_DEPOSITED',
      });
      this.logger.log(`[STRATEGY_HIGH] Deposit to Upbit confirmed.`);

      this.logger.log(
        `[STRATEGY_HIGH] 업비트에서 매도할 ${symbol}의 실제 잔고를 최종 확인합니다...`,
      );
      const upbitBalances = await this.exchangeService.getBalances('upbit');
      const balanceToSell = upbitBalances.find(
        (b) => b.currency === symbol.toUpperCase(),
      );

      if (!balanceToSell || balanceToSell.available <= 0) {
        throw new Error(
          `업비트에서 매도할 ${symbol} 잔고가 없습니다. (최종 확인 실패)`,
        );
      }
      const amountToSell = balanceToSell.available;
      this.logger.log(
        `[STRATEGY_HIGH] 최종 확인된 전량 매도 수량: ${amountToSell} ${symbol}`,
      );

      const filledSellOrder = await this.aggressiveSellOnUpbit(
        cycleId,
        symbol,
        amountToSell,
      );

      // <<<< 신규 추가: 업비트 현물 매도 성공 직후 헷지 숏 포지션 종료 >>>>
      try {
        this.logger.log(
          `[HEDGE] 현물 매도 완료. ${symbol} 숏 포지션 종료를 시작합니다...`,
        );

        const closeShortOrder = await this.exchangeService.createFuturesOrder(
          'binance',
          symbol,
          'buy', // 숏 포지션 종료는 'BUY'
          'market',
          shortPositionAmount, // 진입했던 수량 그대로 청산
        );

        this.logger.log(
          `[HEDGE] 숏 포지션 종료 성공. TxID: ${closeShortOrder.id}`,
        );
        await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
          hp_short_close_tx_id: closeShortOrder.id, // DB에 숏 포지션 종료 주문 ID 기록
        });
      } catch (hedgeError) {
        this.logger.error(
          `[HEDGE_FAIL] 숏 포지션 종료에 실패했습니다: ${hedgeError.message}`,
        );
        await this.telegramService.sendMessage(
          `🚨 [긴급] 사이클 ${cycleId}의 ${symbol} 숏 포지션 종료에 실패했습니다. 즉시 수동 청산 필요!`,
        );
        // 여기서 에러를 던지면 사이클이 FAILED 처리되므로, 일단 로깅 및 알림만 하고 넘어갈 수 있음
      }

      // 안됬을때 방법 생각하기

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
    initialOrderId: string,
    symbol: string,
    initialPrice: number, // ⭐️ 추적을 위해 초기 가격을 받습니다.
    side: OrderSide, // ⭐️ 매수/매도에 따라 가격 조정을 위해 side를 받습니다.
    amount: number, // ⭐️ 재주문 시 사용할 수량을 받습니다.
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
              `[POLLING] Order ${currentOrderId} filled on attempt ${attempt}.`,
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

      // --- 타임아웃 발생: 주문 취소 및 가격 조정 후 재주문 ---
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

          // 가격 조정: 매수는 가격을 올리고, 매도는 가격을 내림
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
          throw error; // 재시도 중 오류 발생 시 사이클 실패 처리
        }
      }
    }

    // 모든 지정가 재시도 실패 시, 에러를 던지는 대신 null을 반환하여 수동 개입을 유도
    this.logger.error(
      `[MANUAL_INTERVENTION_REQ] 지정가 주문이 ${this.ORDER_RETRY_LIMIT}회 모두 실패했습니다. (마지막 주문 ID: ${currentOrderId})`,
    );

    // 마지막 지정가 주문을 취소 시도
    try {
      await this.exchangeService.cancelOrder(exchange, currentOrderId, symbol);
      this.logger.log(`마지막 지정가 주문(${currentOrderId})을 취소했습니다.`);
    } catch (cancelError) {
      this.logger.warn(
        `최종 지정가 주문 취소 실패 (이미 체결되었거나 오류 발생): ${cancelError.message}`,
      );
    }

    // null을 반환하여 handleHighPremiumFlow에서 후속 처리를 하도록 함
    return null;
  }

  private async aggressiveSellOnUpbit(
    cycleId: string,
    symbol: string,
    amountToSell: number,
  ): Promise<Order> {
    this.logger.log(
      `[AGGRESSIVE_SELL] ${amountToSell} ${symbol} 전량 매도를 시작합니다.`,
    );
    const market = `KRW-${symbol.toUpperCase()}`;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        // 1. 5초마다 현재가 조회
        this.logger.verbose(`[AGGRESSIVE_SELL] 현재가 조회를 시도합니다...`);
        const tickerResponse = await axios.get(
          `https://api.upbit.com/v1/ticker?markets=${market}`,
        );
        const currentPrice = tickerResponse.data[0]?.trade_price;

        if (!currentPrice) {
          this.logger.warn(
            `[AGGRESSIVE_SELL] 현재가 조회 실패. 5초 후 재시도합니다.`,
          );
          await delay(5000);
          continue;
        }

        this.logger.log(
          `[AGGRESSIVE_SELL] 현재가: ${currentPrice} KRW. 해당 가격으로 지정가 매도를 시도합니다.`,
        );

        // 2. 현재가로 지정가 매도 주문
        const sellOrder = await this.exchangeService.createOrder(
          'upbit',
          symbol,
          'limit',
          'sell',
          amountToSell,
          currentPrice,
        );

        // 3. 짧은 시간(예: 10초) 동안 체결 여부 확인
        const startTime = Date.now();
        while (Date.now() - startTime < 10000) {
          // 10초간 폴링
          const orderStatus = await this.exchangeService.getOrder(
            'upbit',
            sellOrder.id,
            symbol,
          );
          if (orderStatus.status === 'filled') {
            this.logger.log(
              `[AGGRESSIVE_SELL] 매도 성공! Order ID: ${orderStatus.id}`,
            );
            return orderStatus; // 체결 완료 시, 주문 정보 반환 및 함수 종료
          }
          await delay(2000); // 2초 간격으로 확인
        }

        // 4. 10초 후에도 미체결 시 주문 취소 (다음 루프에서 새로운 가격으로 다시 시도)
        this.logger.log(
          `[AGGRESSIVE_SELL] 10초 내 미체결. 주문을 취소하고 새로운 가격으로 재시도합니다. Order ID: ${sellOrder.id}`,
        );
        await this.exchangeService.cancelOrder('upbit', sellOrder.id, symbol);
      } catch (error) {
        const errorMessage = error.message.toLowerCase();
        // 재시도가 무의미한 특정 에러 키워드들
        const fatalErrors = [
          'insufficient funds',
          'invalid access key',
          'minimum total',
        ];

        if (fatalErrors.some((keyword) => errorMessage.includes(keyword))) {
          this.logger.error(
            `[AGGRESSIVE_SELL] 치명적 오류 발생, 매도를 중단합니다: ${error.message}`,
          );
          // 여기서 에러를 다시 던져서 handleHighPremiumFlow의 메인 catch 블록으로 넘김
          throw error;
        }

        this.logger.error(
          `[AGGRESSIVE_SELL] 매도 시도 중 오류 발생: ${error.message}. 5초 후 재시도합니다.`,
        );
      }
      await delay(5000); // 다음 시도까지 5초 대기
    }
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

    this.logger.log(
      `[POLLING_DEBUG] Initial Balance for ${symbol}: ${initialBalance}`,
    );
    this.logger.log(
      `[POLLING_DEBUG] Expected Amount to Arrive: ${expectedAmount}`,
    );

    // 2. 잔고가 증가할 때까지 대기
    while (Date.now() - startTime < this.DEPOSIT_TIMEOUT_MS) {
      try {
        const currentBalances =
          await this.exchangeService.getBalances(exchange);
        const currentBalance =
          currentBalances.find(
            (b) => b.currency.toUpperCase() === symbol.toUpperCase(),
          )?.available || 0;

        const targetAmount = initialBalance + expectedAmount * 0.999;
        const isDepositConfirmed = currentBalance >= targetAmount;

        this.logger.log(
          `[POLLING_DEBUG] Checking... | Current Balance: ${currentBalance} | Target: >= ${targetAmount.toFixed(8)} | Confirmed: ${isDepositConfirmed}`,
        );

        // 출금 수수료 등을 감안하여, 예상 수량의 99.9% 이상만 들어오면 성공으로 간주
        if (currentBalance >= initialBalance + expectedAmount * 0.995) {
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
