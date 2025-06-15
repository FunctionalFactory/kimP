// src/common/strategy-high.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ArbitrageRecordService } from '../db/arbitrage-record.service';
import { ExchangeService, ExchangeType } from './exchange.service';
import { Order } from './exchange.interface';
import { ConfigService } from '@nestjs/config'; // ⭐️ ConfigService import 추가
import axios from 'axios';
import { BinanceService } from 'src/binance/binance.service'; // ◀️ import 추가

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
    private readonly configService: ConfigService,
    private readonly binanceService: BinanceService, // ◀️ 주입 추가
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

      // 규칙에서 quoteAsset(USDT)의 허용 정밀도(소수점 자릿수)를 가져옵니다.
      const quotePrecision = symbolInfo.quoteAssetPrecision;

      // 투자할 총액(USDT)을 허용된 정밀도에 맞게 조정합니다.
      const adjustedInvestmentUSDT = parseFloat(
        actualInvestmentUSDT.toFixed(quotePrecision),
      );

      this.logger.log(
        `[STRATEGY_HIGH] USDT 총액 정밀도 조정: Raw: ${actualInvestmentUSDT} -> Adjusted: ${adjustedInvestmentUSDT}`,
      );

      const buyOrder = await this.exchangeService.createOrder(
        'binance',
        symbol,
        'market',
        'buy',
        undefined,
        adjustedInvestmentUSDT,
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
        );
      }

      await this.arbitrageRecordService.updateArbitrageCycle(cycleId, {
        status: 'HP_BOUGHT',
        highPremiumBuyTxId: filledBuyOrder.id,
      });
      this.logger.log(
        `[STRATEGY_HIGH] Binance buy order for ${symbol} filled.`,
      );

      this.logger.log(
        `[STRATEGY_HIGH] 교차 검증: 매수 후 실제 바이낸스 잔고를 확인합니다...`,
      );
      // 바이낸스 내부 시스템에 잔고가 반영될 때까지 아주 잠시(1~2초) 기다려줍니다.
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const binanceBalances = await this.exchangeService.getBalances('binance');
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

      // 4. 업비트 매도
      const sellOrder = await this.exchangeService.createOrder(
        'upbit',
        symbol,
        'market',
        'sell',
        amountToSell,
        undefined,
      );
      const filledSellOrder = await this.pollOrderStatus(
        cycleId,
        'upbit',
        sellOrder.id,
        symbol,
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
    symbol: string, // ◀️ symbol 파라미터 추가
  ): Promise<Order> {
    const startTime = Date.now();
    this.logger.log(
      `[POLLING] Start polling for order ${orderId} on ${exchange}. Timeout: ${this.ORDER_TIMEOUT_MS}ms`,
    );

    while (Date.now() - startTime < this.ORDER_TIMEOUT_MS) {
      try {
        const order = await this.exchangeService.getOrder(
          exchange,
          orderId,
          symbol,
        ); // ◀️ symbol 전달
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
