// src/common/exchange.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { UPBIT_EXCHANGE_SERVICE } from '../upbit/upbit.module';
import { BINANCE_EXCHANGE_SERVICE } from '../binance/binance.module';
import {
  IExchange,
  Balance,
  Order,
  OrderBook,
  OrderSide,
  OrderType,
  WalletStatus,
  WithdrawalChance,
  TickerInfo,
} from './exchange.interface';

// 이 서비스에 요청할 때 사용할 거래소 타입
export type ExchangeType = 'upbit' | 'binance';

@Injectable()
export class ExchangeService {
  private readonly logger = new Logger(ExchangeService.name);
  private currentRate = 0; // fallback value

  constructor(
    // 토큰을 사용하여 실제 구현체(Real 또는 Simulation)를 주입받음
    @Inject(UPBIT_EXCHANGE_SERVICE) private readonly upbitService: IExchange,
    @Inject(BINANCE_EXCHANGE_SERVICE)
    private readonly binanceService: IExchange,
  ) {}

  // 요청에 맞는 서비스를 반환하는 내부 헬퍼 함수
  private getService(exchange: ExchangeType): IExchange {
    if (exchange === 'upbit') {
      return this.upbitService;
    }
    return this.binanceService;
  }

  // ======================================================
  // ===== 기존 환율 조회 기능 (그대로 유지) =================
  // ======================================================

  async onModuleInit() {
    await this.updateRate();
  }

  async updateRate() {
    try {
      const res = await axios.get(
        'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=krw',
      );
      const rate = res.data?.tether?.krw;
      if (rate) {
        this.currentRate = rate;
        this.logger.log(`💱 [CoinGecko] 1 USDT ≈ ${rate} KRW`);
      }
    } catch (err) {
      this.logger.error(`❌ 환율 갱신 실패: ${(err as Error).message}`);
    }
  }

  getUSDTtoKRW(): number {
    return this.currentRate;
  }

  @Cron('*/1 * * * *')
  handleRateUpdate() {
    this.updateRate();
  }

  // ======================================================
  // ===== Facade 메소드 (IExchange 인터페이스 중개) ======
  // ======================================================

  async createOrder(
    exchange: ExchangeType,
    symbol: string,
    type: OrderType,
    side: OrderSide,
    amount: number,
    price?: number,
  ): Promise<Order> {
    return this.getService(exchange).createOrder(
      symbol,
      type,
      side,
      amount,
      price,
    );
  }

  async getOrder(
    exchange: ExchangeType,
    orderId: string,
    symbol?: string,
  ): Promise<Order> {
    return this.getService(exchange).getOrder(orderId, symbol);
  }

  async getBalances(exchange: ExchangeType): Promise<Balance[]> {
    return this.getService(exchange).getBalances();
  }

  async getOrderBook(
    exchange: ExchangeType,
    symbol: string,
  ): Promise<OrderBook> {
    return this.getService(exchange).getOrderBook(symbol);
  }

  async getWalletStatus(
    exchange: ExchangeType,
    symbol: string,
  ): Promise<WalletStatus> {
    return this.getService(exchange).getWalletStatus(symbol);
  }

  async getDepositAddress(
    exchange: ExchangeType,
    symbol: string,
  ): Promise<{ address: string; tag?: string; net_type?: string }> {
    return this.getService(exchange).getDepositAddress(symbol);
  }

  async withdraw(
    exchange: ExchangeType,
    symbol: string,
    address: string,
    amount: string,
    secondary_address?: string,
    net_type?: string,
  ): Promise<any> {
    return this.getService(exchange).withdraw(
      symbol,
      address,
      amount,
      secondary_address,
      net_type,
    );
  }

  /**
   * 특정 코인의 출금 제약 조건(수수료, 최소수량 등)을 조회합니다.
   */
  async getWithdrawalChance(
    exchange: ExchangeType,
    symbol: string,
  ): Promise<WithdrawalChance> {
    return this.getService(exchange).getWithdrawalChance(symbol);
  }

  async getTickerInfo(
    exchange: ExchangeType,
    symbol: string,
  ): Promise<TickerInfo> {
    return this.getService(exchange).getTickerInfo(symbol);
  }

  /**
   * 특정 주문을 취소합니다.
   * @param exchange 거래소 타입 ('upbit' 또는 'binance')
   * @param orderId 취소할 주문의 ID
   * @param symbol (선택적) 일부 거래소에서 필요
   * @returns 취소 요청 결과
   */
  async cancelOrder(
    exchange: ExchangeType,
    orderId: string,
    symbol?: string,
  ): Promise<any> {
    return this.getService(exchange).cancelOrder(orderId, symbol);
  }

  /**
   * 선물 주문 요청을 적절한 거래소 서비스로 중개합니다.
   */
  async createFuturesOrder(
    exchange: ExchangeType,
    symbol: string,
    side: OrderSide,
    type: OrderType,
    amount: number,
    price?: number,
  ): Promise<Order> {
    // 현재 시스템에서는 바이낸스만 선물 거래를 지원한다고 가정
    if (exchange !== 'binance') {
      this.logger.error(
        `[ExchangeService] ${exchange}에서는 선물 거래를 지원하지 않습니다.`,
      );
      throw new Error(`Futures trading is not supported on ${exchange}.`);
    }
    // getService('binance')를 통해 실제 BinanceService의 메소드를 호출
    return this.getService(exchange).createFuturesOrder(
      symbol,
      side,
      type,
      amount,
      price,
    );
  }
}
