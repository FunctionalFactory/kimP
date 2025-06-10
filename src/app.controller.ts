// src/app.controller.ts
import { Controller, Get, Logger, Param, Query } from '@nestjs/common';
import { AppService } from './app.service';
import { ExchangeService, ExchangeType } from './common/exchange.service'; // ⭐️ ExchangeService import
import { PriceFeedService } from './marketdata/price-feed.service';
import axios from 'axios';
import { DepositMonitorService } from './arbitrage/deposit-monitor.service';
import { UpbitService } from './upbit/upbit.service';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Controller()
export class AppController {
  private readonly logger = new Logger(AppController.name);
  // [수정] ExchangeService를 생성자에 주입
  constructor(
    private readonly appService: AppService,
    private readonly exchangeService: ExchangeService, // ⭐️ 주입
    private readonly priceFeedService: PriceFeedService,
    private readonly depositMonitorService: DepositMonitorService,
    private readonly upbitService: UpbitService,
  ) {}

  // =================================================================
  // ===================== 전체 플로우 테스트 API =======================
  // =================================================================
  @Get('/test-full-flow')
  async testFullFlow(
    // ⭐️ 요청에 따라 XRP로만 테스트하도록 코인 파라미터를 수정합니다.
    @Query('coin') coin: string = 'XRP',
    @Query('amountKRW') amountKRWStr: string = '20000', // 초기 투자금 (KRW)
  ) {
    this.logger.warn(
      `[FULL FLOW TEST START - ${coin.toUpperCase()}] =======================================`,
    );
    const amountKRW = parseFloat(amountKRWStr);
    const results = [];

    try {
      // ===== 1. 업비트에서 코인 매수 =====
      this.logger.log(
        `[1/8] 업비트에서 ${amountKRW} KRW 만큼 ${coin} 매수 시도...`,
      );

      // ⭐️ [수정] 매수 전 현재 코인 잔고를 먼저 확인합니다.
      this.logger.log(` > 매수 전 업비트의 ${coin} 잔고를 조회합니다...`);
      const initialUpbitBalances =
        await this.exchangeService.getBalances('upbit');
      const initialCoinBalance =
        initialUpbitBalances.find((b) => b.currency === coin.toUpperCase())
          ?.available || 0;
      this.logger.log(` > 조회된 매수 전 ${coin} 잔고: ${initialCoinBalance}`);

      const upbitBuyOrder = await this.exchangeService.createOrder(
        'upbit',
        coin,
        'market',
        'buy',
        undefined,
        amountKRW,
      );

      // ⭐️ [수정] 주문 직후 잠시 대기하여 잔고가 업데이트될 시간을 줍니다.
      this.logger.log(` > 주문 후 잔고 업데이트를 위해 3초 대기...`);
      await delay(3000);

      // ⭐️ [수정] 매수 후 잔고를 다시 조회하여 실제 매수된 수량을 계산합니다.
      this.logger.log(` > 매수 후 업비트의 ${coin} 잔고를 다시 조회합니다...`);
      const finalUpbitBalances =
        await this.exchangeService.getBalances('upbit');
      const finalCoinBalance =
        finalUpbitBalances.find((b) => b.currency === coin.toUpperCase())
          ?.available || 0;
      this.logger.log(` > 조회된 매수 후 ${coin} 잔고: ${finalCoinBalance}`);

      const boughtAmount = finalCoinBalance - initialCoinBalance;

      if (boughtAmount <= 0) {
        throw new Error(
          `업비트에서 코인 매수 후 잔고가 증가하지 않았습니다. 주문 ID: ${upbitBuyOrder.id}`,
        );
      }

      this.logger.log(` > 성공: ${boughtAmount.toFixed(6)} ${coin} 매수 완료.`);
      results.push({
        step: 1,
        status: 'SUCCESS',
        details: `Bought ${boughtAmount.toFixed(6)} ${coin} on Upbit`,
        order: upbitBuyOrder,
      });
      await delay(5000); // 다음 단계 전 5초 대기

      // ===== 2. 업비트 -> 바이낸스로 코인 전송 (출금) =====
      this.logger.log(`[2/8] 업비트에서 바이낸스로 ${coin} 출금 시도...`);
      const binanceDepositInfo = await this.exchangeService.getDepositAddress(
        'binance',
        coin,
      );
      const upbitWithdrawalChance =
        await this.exchangeService.getWithdrawalChance('upbit', coin);
      let withdrawAmount = boughtAmount - upbitWithdrawalChance.fee;

      if (withdrawAmount <= 0) {
        throw new Error(
          `매수된 코인 수량(${boughtAmount})이 출금 수수료(${upbitWithdrawalChance.fee})보다 작아 출금할 수 없습니다.`,
        );
      }
      const upbitPrecision = 10000; // 10^4 (4자리 정밀도) for Upbit
      withdrawAmount =
        Math.floor(withdrawAmount * upbitPrecision) / upbitPrecision;

      const upbitWithdrawResult = await this.exchangeService.withdraw(
        'upbit',
        coin,
        binanceDepositInfo.address,
        withdrawAmount.toString(),
        binanceDepositInfo.tag,
        binanceDepositInfo.net_type,
      );
      this.logger.log(
        ` > 성공: 출금 요청 완료 (TxID: ${upbitWithdrawResult.uuid})`,
      );
      results.push({
        step: 2,
        status: 'SUCCESS',
        details: `Withdrawal from Upbit requested`,
        result: upbitWithdrawResult,
      });

      // ===== 3. 바이낸스 입금 확인 =====
      this.logger.log(`[3/8] 바이낸스에서 ${coin} 입금 모니터링 시작...`);
      const depositResult = await this.depositMonitorService.monitorDeposit(
        'binance',
        coin,
        600,
      ); // 10분 타임아웃
      if (!depositResult || !depositResult.success) {
        throw new Error('바이낸스 입금 확인 실패 또는 타임아웃');
      }
      this.logger.log(
        ` > 성공: ${depositResult.depositedAmount.toFixed(6)} ${coin} 입금 확인!`,
      );
      results.push({
        step: 3,
        status: 'SUCCESS',
        details: `Deposit confirmed on Binance`,
        result: depositResult,
      });

      // ===== 4. 바이낸스에서 코인 전량 매도 =====
      this.logger.log(`[4/8] 바이낸스에서 ${coin} 전량 매도 시도...`);
      const binanceSellOrder = await this.executeSellAll('binance', coin);
      const earnedUSDT = binanceSellOrder.filledAmount * binanceSellOrder.price;
      this.logger.log(
        ` > 성공: 전량 매도 완료. ${earnedUSDT.toFixed(4)} USDT 확보.`,
      );
      results.push({
        step: 4,
        status: 'SUCCESS',
        details: `Sold all ${coin} on Binance`,
        order: binanceSellOrder,
      });
      await delay(5000);

      // ===== 5. 바이낸스에서 다시 코인 매수 =====
      this.logger.log(
        `[5/8] 바이낸스에서 확보한 USDT로 ${coin} 다시 매수 시도...`,
      );

      // ⭐️ [수정] 매수 전, 실제 보유 USDT 잔고를 직접 조회하여 사용합니다.
      this.logger.log(` > 매수 전 바이낸스의 USDT 잔고를 조회합니다...`);
      const binanceBalancesForBuy =
        await this.exchangeService.getBalances('binance');
      const usdtBalance = binanceBalancesForBuy.find(
        (b) => b.currency === 'USDT',
      );

      if (!usdtBalance || usdtBalance.available <= 0) {
        throw new Error(`바이낸스에 매수 가능한 USDT 잔고가 없습니다.`);
      }
      const availableUSDT = usdtBalance.available;
      this.logger.log(` > 조회된 매수 가능 금액: ${availableUSDT} USDT`);

      const binanceReturnCoinBuyOrder = await this.exchangeService.createOrder(
        'binance',
        coin,
        'market',
        'buy',
        undefined,
        availableUSDT,
      );
      results.push({
        step: 5,
        status: 'SUCCESS',
        details: `Bought ${binanceReturnCoinBuyOrder.filledAmount.toFixed(6)} ${coin} on Binance`,
        order: binanceReturnCoinBuyOrder,
      });
      await delay(5000);

      // ===== 6. 바이낸스 -> 업비트로 코인 전송 (출금) =====
      this.logger.log(`[6/8] 바이낸스에서 업비트로 ${coin} 출금 시도...`);

      // ⭐️ [수정] 출금 전, 바이낸스 지갑 상태를 먼저 확인합니다.
      this.logger.log(
        ` > 출금 전 바이낸스의 ${coin} 지갑 상태를 확인합니다...`,
      );
      const walletStatus = await this.exchangeService.getWalletStatus(
        'binance',
        coin,
      );
      if (!walletStatus.canWithdraw) {
        throw new Error(
          `바이낸스 ${coin} 지갑의 출금이 비활성화되어 있습니다.`,
        );
      }
      this.logger.log(` > 지갑 상태 확인 완료: 출금 가능.`);

      this.logger.log(` > 출금 전 바이낸스의 ${coin} 잔고를 조회합니다...`);
      const binanceBalancesForWithdraw =
        await this.exchangeService.getBalances('binance');
      const coinBalance = binanceBalancesForWithdraw.find(
        (b) => b.currency === coin.toUpperCase(),
      );

      if (!coinBalance || coinBalance.available <= 0) {
        throw new Error(`바이낸스에 출금 가능한 ${coin} 잔고가 없습니다.`);
      }
      const availableAmount = coinBalance.available;
      this.logger.log(` > 조회된 출금 가능 수량: ${availableAmount} ${coin}`);

      const upbitDepositInfo = await this.exchangeService.getDepositAddress(
        'upbit',
        coin,
      );
      console.log(upbitDepositInfo);
      const binanceWithdrawalChance =
        await this.exchangeService.getWithdrawalChance('binance', coin);
      let returnWithdrawAmount = availableAmount - binanceWithdrawalChance.fee;

      if (returnWithdrawAmount <= 0) {
        throw new Error(
          `바이낸스 보유 수량(${availableAmount})이 출금 수수료(${binanceWithdrawalChance.fee})보다 작아 출금할 수 없습니다.`,
        );
      }
      const binancePrecision = 100000000;
      returnWithdrawAmount =
        Math.floor(returnWithdrawAmount * binancePrecision) / binancePrecision;

      const binanceWithdrawResult = await this.exchangeService.withdraw(
        'binance',
        coin,
        upbitDepositInfo.address,
        returnWithdrawAmount.toString(),
        upbitDepositInfo.net_type,
        upbitDepositInfo.tag,
      );

      this.logger.log(
        ` > 성공: 출금 요청 완료 (TxID: ${binanceWithdrawResult.id})`,
      );
      results.push({
        step: 6,
        status: 'SUCCESS',
        details: `Withdrawal from Binance requested`,
        result: binanceWithdrawResult,
      });

      // ===== 7. 업비트 입금 확인 =====
      this.logger.log(`[7/8] 업비트에서 ${coin} 입금 모니터링 시작...`);
      const upbitDepositResult =
        await this.depositMonitorService.monitorDeposit('upbit', coin, 600); // 10분 타임아웃
      if (!upbitDepositResult || !upbitDepositResult.success) {
        throw new Error('업비트 입금 확인 실패 또는 타임아웃');
      }
      this.logger.log(
        ` > 성공: ${upbitDepositResult.depositedAmount.toFixed(6)} ${coin} 입금 확인!`,
      );
      results.push({
        step: 7,
        status: 'SUCCESS',
        details: `Deposit confirmed on Upbit`,
        result: upbitDepositResult,
      });

      // ===== 8. 업비트에서 코인 전량 매도 =====
      this.logger.log(`[8/8] 업비트에서 ${coin} 전량 매도 시도...`);
      const finalSellOrder = await this.executeSellAll('upbit', coin);
      const finalKRW = finalSellOrder.filledAmount * finalSellOrder.price;
      this.logger.log(
        ` > 성공: 최종 매도 완료. ${finalKRW.toFixed(0)} KRW 확보.`,
      );
      results.push({
        step: 8,
        status: 'SUCCESS',
        details: `Sold all ${coin} on Upbit`,
        order: finalSellOrder,
      });

      // 최종 결과 로깅
      const profit = finalKRW - amountKRW;
      this.logger.warn(
        `[FULL FLOW TEST COMPLETE - ${coin.toUpperCase()}] =================================`,
      );
      this.logger.log(` > 초기 투자금: ${amountKRW.toFixed(0)} KRW`);
      this.logger.log(` > 최종 회수금: ${finalKRW.toFixed(0)} KRW`);
      this.logger.log(` > 총 손익 (PNL): ${profit.toFixed(0)} KRW`);
      this.logger.log(` > 수익률: ${((profit / amountKRW) * 100).toFixed(2)}%`);
      this.logger.warn(
        `======================================================================`,
      );

      return {
        message: 'Full flow test completed successfully.',
        initialInvestmentKRW: amountKRW,
        finalReturnKRW: finalKRW,
        profitAndLoss: profit,
        steps: results,
      };
    } catch (error) {
      this.logger.error(
        `[FULL FLOW TEST FAILED] ❌ ${error.message}`,
        error.stack,
      );
      results.push({
        step: results.length + 1,
        status: 'FAILED',
        details: error.message,
      });
      return {
        message: 'Full flow test failed.',
        error: error.message,
        completedSteps: results,
      };
    }
  }

  /**
   * 전량 매도를 위한 헬퍼 함수
   * @param exchange 거래소
   * @param symbol 코인 심볼
   */
  private async executeSellAll(
    exchange: ExchangeType,
    symbol: string,
  ): Promise<any> {
    const upperCaseSymbol = symbol.toUpperCase();
    const balances = await this.exchangeService.getBalances(exchange);
    const targetBalance = balances.find((b) => b.currency === upperCaseSymbol);

    if (!targetBalance || targetBalance.available <= 0) {
      throw new Error(
        `No available balance of ${upperCaseSymbol} on ${exchange} to sell.`,
      );
    }

    const sellAmount = targetBalance.available;

    // 바이낸스의 경우, 수량 정밀도(stepSize)에 맞춰 조정 필요
    if (exchange === 'binance') {
      const market = `${upperCaseSymbol}USDT`;
      const exchangeInfoRes = await axios.get(
        'https://api.binance.com/api/v3/exchangeInfo',
      );
      const symbolInfo = exchangeInfoRes.data.symbols.find(
        (s: any) => s.symbol === market,
      );
      const lotSizeFilter = symbolInfo.filters.find(
        (f: any) => f.filterType === 'LOT_SIZE',
      );
      const stepSize = parseFloat(lotSizeFilter.stepSize);
      const adjustedSellAmount = Math.floor(sellAmount / stepSize) * stepSize;

      if (adjustedSellAmount <= 0) {
        throw new Error(
          `Adjusted sell amount for ${upperCaseSymbol} is too small.`,
        );
      }
      return this.exchangeService.createOrder(
        exchange,
        upperCaseSymbol,
        'market',
        'sell',
        adjustedSellAmount,
      );
    }

    // 업비트는 시장가 매도 시 수량으로 주문
    return this.exchangeService.createOrder(
      exchange,
      upperCaseSymbol,
      'market',
      'sell',
      sellAmount,
    );
  }

  /**
   * ⭐️ [신규 추가] 업비트에서 특정 코인이 지원하는 네트워크 타입 목록을 조회하는 테스트 API
   */
  @Get('/test-get-network-type')
  async testGetNetworkType() {
    this.logger.log(`[/test-get-network-type] Received test request for`);
    try {
      // UpbitService의 새 함수를 직접 호출
      const supportedNetworks = await this.upbitService.getSupportedNetworks();

      return {
        message: `Successfully fetched supported networks for from Upbit.`,
        supported_networks: supportedNetworks,
      };
    } catch (error) {
      return {
        message: `Failed to fetch supported networks for.`,
        error: error.message,
      };
    }
  }

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  // ========================= [테스트용 코드 추가] =========================
  @Get('/test-upbit-balance')
  async testUpbitBalance() {
    this.exchangeService.getUSDTtoKRW();
    this.logger.log('[/test-upbit-balance] Received test request.');
    try {
      // 'upbit'의 잔고 조회를 요청합니다.
      const balances = await this.exchangeService.getBalances('upbit');
      return {
        message: 'Successfully fetched Upbit balances.',
        data: balances,
      };
    } catch (error) {
      return {
        message: 'Failed to fetch Upbit balances.',
        error: error.message,
      };
    }
  }
  // ====================== [바이낸스 테스트용 코드 추가] ======================
  @Get('/test-binance-balance')
  async testBinanceBalance() {
    this.logger.log('[/test-binance-balance] Received test request.');
    try {
      // 'binance'의 잔고 조회를 요청합니다.
      const balances = await this.exchangeService.getBalances('binance');
      return {
        message: 'Successfully fetched Binance balances.',
        data: balances,
      };
    } catch (error) {
      return {
        message: 'Failed to fetch Binance balances.',
        error: error.message,
      };
    }
  }
  // ====================== [지정 금액만큼 매수 기능 테스트용 코드 수정] ======================
  @Get('/test-buy-by-value')
  async testBuyByValue(
    @Query('exchange') exchange: ExchangeType,
    @Query('symbol') symbol: string,
    @Query('amount') amountStr: string,
    @Query('unit') unit: 'USDT' | 'KRW',
  ) {
    this.logger.log(`[/test-buy-by-value] Received request.`);

    try {
      if (!exchange || !symbol || !amountStr || !unit) {
        throw new Error(
          'Please provide all required query parameters: exchange, symbol, amount, unit.',
        );
      }

      const amount = parseFloat(amountStr);
      if (isNaN(amount) || amount <= 0) {
        throw new Error('Amount must be a positive number.');
      }

      const upperCaseSymbol = symbol.toUpperCase();
      let totalCost = amount;
      const targetExchange = exchange;

      this.logger.log(
        `Attempting to buy ${totalCost} ${unit} worth of ${upperCaseSymbol} on ${targetExchange}...`,
      );

      // 업비트에서 USDT 금액으로 구매 요청 시, KRW로 환산
      if (targetExchange === 'upbit' && unit === 'USDT') {
        const rate = this.exchangeService.getUSDTtoKRW();
        if (rate <= 0) {
          throw new Error('USDT to KRW rate is not available.');
        }
        totalCost = amount * rate;
        this.logger.log(`Converted ${amount} USDT to ${totalCost} KRW.`);
      } else if (targetExchange === 'binance' && unit === 'KRW') {
        throw new Error(
          'Buying with KRW on Binance is not supported. Please use USDT.',
        );
      }

      // [추가] 주문 전 잔고 확인 로직
      if (targetExchange === 'binance' && unit === 'USDT') {
        this.logger.log('Checking available USDT balance on Binance...');
        const binanceBalances =
          await this.exchangeService.getBalances('binance');
        const usdtBalance = binanceBalances.find((b) => b.currency === 'USDT');
        const availableUsdt = usdtBalance?.available || 0;

        if (availableUsdt < totalCost) {
          throw new Error(
            `Available USDT balance is insufficient. Required: ${totalCost}, Available: ${availableUsdt}`,
          );
        }
        this.logger.log(
          `Sufficient balance found. Available: ${availableUsdt} USDT.`,
        );
      } else if (targetExchange === 'upbit' && unit === 'KRW') {
        this.logger.log('Checking available KRW balance on Upbit...');
        const upbitBalances = await this.exchangeService.getBalances('upbit');
        const krwBalance = upbitBalances.find((b) => b.currency === 'KRW');
        const availableKrw = krwBalance?.available || 0;

        if (availableKrw < totalCost) {
          throw new Error(
            `Available KRW balance is insufficient. Required: ${totalCost}, Available: ${availableKrw}`,
          );
        }
        this.logger.log(
          `Sufficient balance found. Available: ${availableKrw} KRW.`,
        );
      }

      // 시장가 매수 주문 생성
      // createOrder의 4번째(amount) 파라미터는 null, 5번째(price) 파라미터에 총액을 전달
      const createdOrder = await this.exchangeService.createOrder(
        targetExchange,
        upperCaseSymbol,
        'market',
        'buy',
        undefined, // 시장가 매수 시 수량은 미지정
        totalCost, // 총액으로 주문
      );

      const successMsg = `✅ Successfully created a market buy order for ${totalCost.toFixed(4)} ${unit} worth of ${upperCaseSymbol} on ${targetExchange}.`;
      this.logger.log(successMsg);

      return {
        message: successMsg,
        createdOrder,
      };
    } catch (error) {
      this.logger.error(
        `[TestBuyByValue] Failed: ${error.message}`,
        error.stack,
      );
      return {
        message: 'Failed to execute buy-by-value test.',
        error: error.message,
      };
    }
  }

  // ====================== [업비트 주문 테스트용 코드 최종 수정] ======================
  @Get('/test-upbit-order')
  async testUpbitOrder() {
    this.logger.log('[/test-upbit-order] Received test request.');
    try {
      const symbol = 'XRP';
      const amount = 10;
      const market = 'KRW-XRP';

      // [수정] 웹소켓 대신 REST API로 현재가를 직접 조회하여 안정성 확보
      this.logger.log(`Fetching current price for ${market} via REST API...`);
      const response = await axios.get(
        `https://api.upbit.com/v1/ticker?markets=${market}`,
      );

      const currentPrice = response.data[0]?.trade_price;

      if (!currentPrice) {
        throw new Error('Could not fetch current price via Upbit REST API.');
      }
      this.logger.log(`Current price is ${currentPrice} KRW.`);

      this.logger.log(
        `Attempting to create a test order: ${amount} ${symbol} at ${currentPrice} KRW`,
      );

      // 현재가로 지정가 매수 주문
      const createdOrder = await this.exchangeService.createOrder(
        'upbit',
        symbol,
        'limit',
        'buy',
        amount,
        currentPrice,
      );

      this.logger.log(
        `Order created successfully: ${createdOrder.id}. Now fetching status...`,
      );
      // 주문 상태 조회
      const orderStatus = await this.exchangeService.getOrder(
        'upbit',
        createdOrder.id,
      );

      return {
        message:
          'Successfully created and fetched Upbit order using REST API price.',
        createdOrder,
        fetchedStatus: orderStatus,
      };
    } catch (error) {
      this.logger.error(
        `Failed to create or fetch Upbit order: ${error.message}`,
        error.stack,
      );
      return {
        message: 'Failed to create or fetch Upbit order.',
        error: error.message,
      };
    }
  }
  // ==================== [바이낸스 주문 테스트용 코드 추가] ====================
  @Get('/test-binance-order')
  async testBinanceOrder() {
    this.logger.log('[/test-binance-order] Received test request.');
    try {
      // XRP를 0.1 USDT에 10개 매수하는 테스트 주문 (체결되지 않을 만한 가격)
      const symbol = 'XRP';
      const price = 0.1;
      const amount = 10;

      this.logger.log(
        `Attempting to create a test order: ${amount} ${symbol} at ${price} USDT`,
      );
      const createdOrder = await this.exchangeService.createOrder(
        'binance',
        symbol,
        'limit',
        'buy',
        amount,
        price,
      );

      this.logger.log(
        `Order created successfully: ${createdOrder.id}. Now fetching status...`,
      );
      // 바이낸스 주문 조회 시 symbol 정보가 필요합니다.
      const orderStatus = await this.exchangeService.getOrder(
        'binance',
        createdOrder.id,
        symbol,
      );

      return {
        message: 'Successfully created and fetched Binance order.',
        createdOrder,
        fetchedStatus: orderStatus,
      };
    } catch (error) {
      return {
        message: 'Failed to create or fetch Binance order.',
        error: error.message,
      };
    }
  }
  // ====================== [지갑 상태 테스트용 코드 추가] ======================
  @Get('/test-wallet-status/:symbol')
  async testWalletStatus(@Param('symbol') symbol: string) {
    this.logger.log(
      `[/test-wallet-status] Received test request for ${symbol}`,
    );
    try {
      const upbitStatus = await this.exchangeService.getWalletStatus(
        'upbit',
        symbol,
      );
      const binanceStatus = await this.exchangeService.getWalletStatus(
        'binance',
        symbol,
      );

      return {
        message: `Successfully fetched wallet status for ${symbol}.`,
        data: {
          upbit: upbitStatus,
          binance: binanceStatus,
        },
      };
    } catch (error) {
      return {
        message: `Failed to fetch wallet status for ${symbol}.`,
        error: error.message,
      };
    }
  }
  // ====================== [입금 주소 테스트용 코드 추가] ======================
  @Get('/test-deposit-address/:symbol')
  async testDepositAddress(@Param('symbol') symbol: string) {
    this.logger.log(
      `[/test-deposit-address] Received test request for ${symbol}`,
    );
    try {
      const upbitAddress = await this.exchangeService.getDepositAddress(
        'upbit',
        symbol,
      );
      const binanceAddress = await this.exchangeService.getDepositAddress(
        'binance',
        symbol,
      );

      return {
        message: `Successfully fetched deposit address for ${symbol}.`,
        data: {
          upbit: upbitAddress,
          binance: binanceAddress,
        },
      };
    } catch (error) {
      return {
        message: `Failed to fetch deposit address for ${symbol}.`,
        error: error.message,
      };
    }
  }
  // ====================== [출금 테스트용 코드 추가] ======================
  // 이 엔드포인트는 테스트 후 반드시 삭제하거나 주석 처리하세요.
  @Get('/test-upbit-withdraw')
  async testUpbitWithdraw() {
    this.logger.warn('[CAUTION] Executing UPBIT WITHDRAWAL TEST.');
    try {
      // ⚠️ 여기에 본인의 '바이낸스' XRP 입금 주소와 태그, 그리고 아주 적은 수량을 입력하세요.
      const symbol = process.env.UPBIT_SYMBOL;
      const data1 = await this.exchangeService.getDepositAddress(
        'upbit',
        symbol,
      );
      const data2 = await this.exchangeService.getDepositAddress(
        'binance',
        symbol,
      );
      const address = data2.address;
      const net_type = data1.net_type;
      const secondary_address = data2.tag;
      const amount = 17; // 테스트용 최소 수량

      const fee = await this.exchangeService.getWithdrawalChance(
        'upbit',
        symbol,
      );

      const able_amount = amount - fee.fee;

      if (address.includes('YOUR_')) {
        return {
          message:
            'Please edit the controller file with your real address and tag for testing.',
        };
      }

      const result = await this.exchangeService.withdraw(
        'upbit',
        symbol,
        address,
        able_amount.toString(),
        secondary_address,
        net_type,
      );
      return {
        message: 'Successfully sent Upbit withdrawal request.',
        data: result,
      };
    } catch (error) {
      return {
        message: 'Failed to withdraw from Upbit.',
        error: error.message,
      };
    }
  }
  // ====================== [바이낸스 출금 테스트용 코드 추가] ======================
  @Get('/test-binance-withdraw')
  async testBinanceWithdraw() {
    this.logger.warn('[CAUTION] Executing BINANCE WITHDRAWAL TEST.');
    try {
      const symbol = 'XRP'; // 예: 'XRP'
      // const network = await this.exchangeService.getWalletStatus(
      //   'binance',
      //   symbol,
      // );
      const fee = await this.exchangeService.getWithdrawalChance(
        'binance',
        symbol,
      );
      // 1. 테스트용 정보 설정 (실제 값은 .env 파일에서 관리)
      const net_type = symbol; // 예: 'XRP'
      const amount = 18.157; // 테스트용 최소 수량 (바이낸스 최소 출금량에 맞춰 조절 필요)
      const able_amount = amount - fee.fee;

      if (!symbol || !net_type) {
        return {
          message:
            'Please set BINANCE_SYMBOL and BINANCE_NET_TYPE in your .env file for testing.',
        };
      }

      // 2. 업비트에서 입금 주소 가져오기 (목적지 주소)
      this.logger.log(`Fetching Upbit deposit address for ${symbol}...`);
      const upbitDepositInfo = await this.exchangeService.getDepositAddress(
        'upbit',
        symbol,
      );

      if (!upbitDepositInfo || !upbitDepositInfo.address) {
        throw new Error(
          `Could not fetch deposit address from Upbit for ${symbol}. Please ensure the address is generated on Upbit.`,
        );
      }

      this.logger.log(
        `Destination address fetched from Upbit: Address=${upbitDepositInfo.address}, Tag=${upbitDepositInfo.tag}`,
      );
      this.logger.log(
        `Attempting to withdraw ${amount} ${symbol} (Network: ${net_type}) from Binance to Upbit...`,
      );

      // 3. 바이낸스에서 출금 실행
      const result = await this.exchangeService.withdraw(
        'binance',
        symbol,
        upbitDepositInfo.address,
        able_amount.toString(),
        net_type,
        upbitDepositInfo.tag,
      );

      return {
        message: 'Successfully sent Binance withdrawal request.',
        data: result,
      };
    } catch (error) {
      this.logger.error(
        `Failed to withdraw from Binance: ${error.message}`,
        error.stack,
      );
      return {
        message: 'Failed to withdraw from Binance.',
        error: error.message,
      };
    }
  }
  // ====================== [업비트 전량 매도 테스트용 코드 추가] ======================
  @Get('/test-upbit-sell-all/:symbol')
  async testUpbitSellAll(@Param('symbol') symbol: string) {
    const upperCaseSymbol = symbol.toUpperCase();
    this.logger.log(
      `[/test-upbit-sell-all] Received test request for ${upperCaseSymbol}.`,
    );

    try {
      // 1. 해당 코인의 현재 보유 잔고를 조회합니다.
      this.logger.log(
        `Fetching balances from Upbit to get available ${upperCaseSymbol}...`,
      );
      const balances = await this.exchangeService.getBalances('upbit');
      const targetBalance = balances.find(
        (b) => b.currency === upperCaseSymbol,
      );

      if (!targetBalance || targetBalance.available <= 0) {
        throw new Error(`No available balance for ${upperCaseSymbol} to sell.`);
      }

      const sellAmount = targetBalance.available;
      this.logger.log(
        `Available balance to sell: ${sellAmount} ${upperCaseSymbol}.`,
      );

      // 2. REST API로 현재가를 조회합니다.
      const market = `KRW-${upperCaseSymbol}`;
      this.logger.log(`Fetching current price for ${market} via REST API...`);
      const response = await axios.get(
        `https://api.upbit.com/v1/ticker?markets=${market}`,
      );
      const currentPrice = response.data[0]?.trade_price;

      if (!currentPrice) {
        throw new Error(
          `Could not fetch current price for ${market} via Upbit REST API.`,
        );
      }
      this.logger.log(`Current price is ${currentPrice} KRW.`);

      // 3. 조회된 수량과 가격으로 전량 매도 주문을 생성합니다.
      this.logger.log(
        `Attempting to create a sell order: ${sellAmount} ${upperCaseSymbol} at ${currentPrice} KRW.`,
      );
      const createdOrder = await this.exchangeService.createOrder(
        'upbit',
        upperCaseSymbol,
        'limit', // 지정가
        'sell', // 매도
        sellAmount,
        currentPrice,
      );

      // 4. 생성된 주문의 상태를 조회합니다.
      this.logger.log(
        `Sell order created successfully: ${createdOrder.id}. Now fetching status...`,
      );
      const orderStatus = await this.exchangeService.getOrder(
        'upbit',
        createdOrder.id,
      );

      return {
        message: `Successfully created and fetched a sell order for all available ${upperCaseSymbol}.`,
        createdOrder,
        fetchedStatus: orderStatus,
      };
    } catch (error) {
      this.logger.error(
        `Failed to create or fetch Upbit sell order for ${upperCaseSymbol}: ${error.message}`,
        error.stack,
      );
      return {
        message: `Failed to create or fetch Upbit sell order for ${upperCaseSymbol}.`,
        error: error.message,
      };
    }
  }
  // ====================== [바이낸스 전량 매도 테스트용 코드 수정] ======================
  @Get('/test-binance-sell-all/:symbol')
  async testBinanceSellAll(@Param('symbol') symbol: string) {
    const upperCaseSymbol = symbol.toUpperCase();
    this.logger.log(
      `[/test-binance-sell-all] Received test request to sell all ${upperCaseSymbol}.`,
    );
    try {
      const market = `${upperCaseSymbol}USDT`;

      // [추가] 1. 바이낸스에서 거래 규칙(Exchange Info)을 가져옵니다.
      this.logger.log(`Fetching exchange info for ${market}...`);
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
      const stepSize = parseFloat(lotSizeFilter.stepSize);
      this.logger.log(` > Step size for ${market} is ${stepSize}`);

      // 2. 판매할 코인의 바이낸스 잔고를 조회합니다.
      this.logger.log(
        `Fetching balances from Binance to get available ${upperCaseSymbol}...`,
      );
      const balances = await this.exchangeService.getBalances('binance');
      const targetBalance = balances.find(
        (b) => b.currency === upperCaseSymbol,
      );

      if (!targetBalance || targetBalance.available <= 0) {
        throw new Error(`No available balance for ${upperCaseSymbol} to sell.`);
      }
      const availableAmount = targetBalance.available;
      this.logger.log(
        `Available balance to sell (before adjustment): ${availableAmount} ${upperCaseSymbol}.`,
      );

      // [추가] 3. 조회된 잔고를 stepSize 규칙에 맞게 조정합니다.
      const adjustedSellAmount =
        Math.floor(availableAmount / stepSize) * stepSize;
      // 조정된 수량이 0보다 작거나 같으면 판매 불가
      if (adjustedSellAmount <= 0) {
        throw new Error(
          `Adjusted sell amount (${adjustedSellAmount}) is zero or less. Cannot create order.`,
        );
      }
      this.logger.log(`Adjusted sell amount: ${adjustedSellAmount}`);

      // 4. 바이낸스 REST API로 현재가를 조회합니다.
      this.logger.log(
        `Fetching current price for ${market} via Binance REST API...`,
      );
      const response = await axios.get(
        `https://api.binance.com/api/v3/ticker/price?symbol=${market}`,
      );
      const currentPrice = parseFloat(response.data.price);

      if (!currentPrice || isNaN(currentPrice)) {
        throw new Error(`Could not fetch a valid current price for ${market}.`);
      }
      this.logger.log(`Current price is ${currentPrice} USDT.`);

      // 5. 조정된 수량과 현재가로 전량 매도 주문을 생성합니다.
      this.logger.log(
        `Attempting to create a SELL order: ${adjustedSellAmount} ${upperCaseSymbol} at ${currentPrice} USDT.`,
      );
      const createdOrder = await this.exchangeService.createOrder(
        'binance',
        upperCaseSymbol,
        'limit', // 지정가
        'sell', // 매도
        adjustedSellAmount, // 조정된 수량 사용
        currentPrice,
      );

      // 6. 생성된 주문의 상태를 조회합니다.
      this.logger.log(
        `Sell order created successfully: ${createdOrder.id}. Now fetching status...`,
      );
      const orderStatus = await this.exchangeService.getOrder(
        'binance',
        createdOrder.id,
        upperCaseSymbol, // 바이낸스 주문 조회에는 심볼이 필요
      );

      return {
        message: `Successfully created and fetched a sell order for all available ${upperCaseSymbol} on Binance.`,
        createdOrder,
        fetchedStatus: orderStatus,
      };
    } catch (error) {
      this.logger.error(
        `Failed to create or fetch Binance sell order for ${upperCaseSymbol}: ${error.message}`,
        error.stack,
      );
      return {
        message: `Failed to create or fetch Binance sell order for ${upperCaseSymbol}.`,
        error: error.message,
      };
    }
  }
}
