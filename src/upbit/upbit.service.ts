// src/upbit/upbit.service.ts
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
import { ConfigService } from '@nestjs/config';
import { sign } from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { createHash } from 'crypto'; // 주문 기능 구현 시 필요

@Injectable()
export class UpbitService implements IExchange {
  private readonly logger = new Logger(UpbitService.name);
  private readonly accessKey: string;
  private readonly secretKey: string;
  private readonly serverUrl = 'https://api.upbit.com';

  constructor(private readonly configService: ConfigService) {
    this.accessKey = this.configService.get<string>('UPBIT_ACCESS_KEY');
    this.secretKey = this.configService.get<string>('UPBIT_SECRET_KEY');

    if (!this.accessKey || !this.secretKey) {
      this.logger.error('Upbit API Key is missing. Please check .env file.');
    } else {
      this.logger.log('UpbitService (REAL) has been initialized.');
    }
  }

  /**
   * 업비트 API 인증을 위한 JWT 토큰을 생성합니다.
   * 쿼리 파라미터가 있는 경우, 이를 포함하여 토큰을 생성해야 합니다.
   * @param params - API 요청에 포함될 쿼리 또는 바디 파라미터
   * @returns 생성된 JWT
   */
  private generateToken(params: any = {}): string {
    const payload: {
      access_key: string;
      nonce: string;
      query_hash?: string;
      query_hash_alg?: string;
    } = {
      access_key: this.accessKey,
      nonce: uuidv4(),
    };

    // GET, DELETE 요청 외에 body 파라미터가 있는 경우
    if (Object.keys(params).length > 0) {
      const queryString = new URLSearchParams(params).toString();
      const hash = createHash('sha512');
      const queryHash = hash.update(queryString, 'utf-8').digest('hex');

      payload.query_hash = queryHash;
      payload.query_hash_alg = 'SHA512';
    }

    return sign(payload, this.secretKey);
  }

  async getBalances(): Promise<Balance[]> {
    const token = this.generateToken(); // 잔고 조회는 파라미터가 없음
    const url = `${this.serverUrl}/v1/accounts`;

    try {
      const response = await axios.get<any[]>(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      // 업비트 응답 데이터를 우리가 정의한 Balance 인터페이스 형태로 변환
      const balances: Balance[] = response.data.map((item) => {
        const balance = parseFloat(item.balance);
        const locked = parseFloat(item.locked);
        return {
          currency: item.currency,
          balance: balance,
          locked: locked,
          available: balance - locked,
        };
      });

      this.logger.log(
        `[Upbit-REAL] Successfully fetched ${balances.length} balances.`,
      );
      return balances;
    } catch (error) {
      const errorMessage =
        error.response?.data?.error?.message || error.message;
      this.logger.error(`[Upbit-REAL] Failed to get balances: ${errorMessage}`);
      throw new Error(`Upbit API Error: ${errorMessage}`);
    }
  }

  // --- 이하 메소드들은 아직 구현되지 않았습니다 ---

  async createOrder(
    symbol: string,
    type: OrderType,
    side: OrderSide,
    amount: number,
    price?: number,
  ): Promise<Order> {
    // TODO: 업비트 주문 API 연동 로직 구현 (generateToken에 파라미터 전달 필요)
    throw new Error('Upbit createOrder not implemented.');
  }

  async getOrder(orderId: string, symbol?: string): Promise<Order> {
    // TODO: 업비트 개별 주문 조회 API 연동 로직 구현
    throw new Error('Upbit getOrder not implemented.');
  }

  async getOrderBook(symbol: string): Promise<OrderBook> {
    // TODO: 업비트 호가창 조회 API 연동 로직 구현
    throw new Error('Upbit getOrderBook not implemented.');
  }

  async getWalletStatus(symbol: string): Promise<WalletStatus> {
    // TODO: 업비트 입출금 현황 API 연동 로직 구현
    throw new Error('Upbit getWalletStatus not implemented.');
  }

  async getDepositAddress(
    symbol: string,
  ): Promise<{ address: string; tag?: string }> {
    // TODO: 업비트 개별 입금 주소 조회 API 연동 로직 구현
    throw new Error('Upbit getDepositAddress not implemented.');
  }

  async withdraw(
    symbol: string,
    address: string,
    amount: number,
    tag?: string,
  ): Promise<any> {
    // TODO: 업비트 출금하기 API 연동 로직 구현
    throw new Error('Upbit withdraw not implemented.');
  }
}
