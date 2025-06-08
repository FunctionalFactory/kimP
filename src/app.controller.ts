// src/app.controller.ts
import { Controller, Get, Logger, Param } from '@nestjs/common';
import { AppService } from './app.service';
import { ExchangeService } from './common/exchange.service'; // ⭐️ ExchangeService import
import { PriceFeedService } from './marketdata/price-feed.service';
import axios from 'axios';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Controller()
export class AppController {
  private readonly logger = new Logger(AppController.name);
  // [수정] ExchangeService를 생성자에 주입
  constructor(
    private readonly appService: AppService,
    private readonly exchangeService: ExchangeService, // ⭐️ 주입
    private readonly priceFeedService: PriceFeedService,
  ) {}

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
  // ====================== [업비트 주문 테스트용 코드 최종 수정] ======================
  @Get('/test-upbit-order')
  async testUpbitOrder() {
    this.logger.log('[/test-upbit-order] Received test request.');
    try {
      const symbol = 'XRP';
      const amount = 5;
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
      console.log('upbitAddress', upbitAddress);
      console.log('binanceAddress', binanceAddress);

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
      const amount = 7.9941; // 테스트용 최소 수량

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
      const amount = 7.5941; // 테스트용 최소 수량 (바이낸스 최소 출금량에 맞춰 조절 필요)
      const able_amount = amount - fee.fee;
      console.log(fee);

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
  // =====================================================================
}
