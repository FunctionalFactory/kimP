// src/binance/binance.service.ts
import { Injectable, Logger } from '@nestjs/common';
import {
  IExchange,
  Order,
  Balance,
  OrderBook,
  OrderType,
  OrderSide,
  WalletStatus,
} from '../common/exchange.interface';

@Injectable()
export class BinanceService implements IExchange {
  private readonly logger = new Logger(BinanceService.name);

  constructor() {
    this.logger.log('BinanceService (REAL) has been initialized.');
  }

  // 모든 메소드는 IExchange 인터페이스를 따라야 합니다.
  async createOrder(
    symbol: string,
    type: OrderType,
    side: OrderSide,
    amount: number,
    price?: number,
  ): Promise<Order> {
    // TODO: 실제 바이낸스 주문 API 연동 로직 구현 (HMAC-SHA256 인증 포함)
    this.logger.log(
      `[Binance-REAL] Creating ${side} order for ${amount} ${symbol}`,
    );
    throw new Error('Binance createOrder not implemented.');
  }

  async getOrder(orderId: string, symbol?: string): Promise<Order> {
    // TODO: 실제 바이낸스 주문 조회 API 연동 로직 구현
    throw new Error('Binance getOrder not implemented.');
  }

  async getBalances(): Promise<Balance[]> {
    // TODO: 실제 바이낸스 잔고 조회 API 연동 로직 구현
    throw new Error('Binance getBalances not implemented.');
  }

  async getOrderBook(symbol: string): Promise<OrderBook> {
    // TODO: 실제 바이낸스 호가창 조회 API 연동 로직 구현
    throw new Error('Binance getOrderBook not implemented.');
  }

  async getWalletStatus(symbol: string): Promise<WalletStatus> {
    // TODO: 실제 바이낸스 입출금 상태 조회 API 연동 로직 구현
    throw new Error('Binance getWalletStatus not implemented.');
  }

  async getDepositAddress(
    symbol: string,
  ): Promise<{ address: string; tag?: string }> {
    // TODO: 실제 바이낸스 입금 주소 조회 API 연동 로직 구현
    throw new Error('Binance getDepositAddress not implemented.');
  }

  async withdraw(
    symbol: string,
    address: string,
    amount: number,
    tag?: string,
  ): Promise<any> {
    // TODO: 실제 바이낸스 출금 API 연동 로직 구현
    throw new Error('Binance withdraw not implemented.');
  }
}
