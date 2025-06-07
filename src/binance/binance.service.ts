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
  OrderStatus,
  WithdrawalChance,
} from '../common/exchange.interface';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as crypto from 'crypto';
import * as querystring from 'querystring'; // ⭐️ querystring 모듈 import

@Injectable()
export class BinanceService implements IExchange {
  private readonly logger = new Logger(BinanceService.name);
  private readonly apiKey: string;
  private readonly secretKey: string;
  private readonly serverUrl = 'https://api.binance.com';

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>('BINANCE_API_KEY');
    this.secretKey = this.configService.get<string>('BINANCE_SECRET_KEY');

    if (!this.apiKey || !this.secretKey) {
      this.logger.error('Binance API Key is missing. Please check .env file.');
    } else {
      this.logger.log('BinanceService (REAL) has been initialized.');
    }
  }

  /**
   * 바이낸스 API 인증을 위한 HMAC-SHA256 서명을 생성합니다.
   * @param queryString - API 요청에 포함될 쿼리스트링 (예: 'timestamp=12345678')
   * @returns 생성된 서명
   */
  private _generateSignature(queryString: string): string {
    return crypto
      .createHmac('sha256', this.secretKey)
      .update(queryString)
      .digest('hex');
  }

  // [구현 완료]
  async getBalances(): Promise<Balance[]> {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = this._generateSignature(queryString);
    const url = `${this.serverUrl}/api/v3/account?${queryString}&signature=${signature}`;

    try {
      const response = await axios.get(url, {
        headers: { 'X-MBX-APIKEY': this.apiKey },
      });

      // 잔액이 0보다 큰 자산만 필터링하고, 우리가 정의한 Balance 인터페이스 형태로 변환
      const balances: Balance[] = response.data.balances
        .map((item: any) => {
          const free = parseFloat(item.free);
          const locked = parseFloat(item.locked);
          return {
            currency: item.asset,
            balance: free + locked,
            locked: locked,
            available: free,
          };
        })
        .filter((item: Balance) => item.balance > 0);

      this.logger.log(
        `[Binance-REAL] Successfully fetched ${balances.length} balances with positive amount.`,
      );
      return balances;
    } catch (error) {
      const errorMessage = error.response?.data?.msg || error.message;
      this.logger.error(
        `[Binance-REAL] Failed to get balances: ${errorMessage}`,
      );
      throw new Error(`Binance API Error: ${errorMessage}`);
    }
  }

  // [구현 완료]
  async createOrder(
    symbol: string,
    type: OrderType,
    side: OrderSide,
    amount: number,
    price?: number,
  ): Promise<Order> {
    const endpoint = '/api/v3/order';
    const params: any = {
      symbol: `${symbol.toUpperCase()}USDT`,
      side: side.toUpperCase(),
      type: type.toUpperCase(),
      quantity: amount,
      timestamp: Date.now(),
    };

    if (type === 'limit') {
      params.timeInForce = 'GTC'; // Good-Til-Canceled
      params.price = price;
    }

    const queryString = querystring.stringify(params);
    const signature = this._generateSignature(queryString);
    const url = `${this.serverUrl}${endpoint}?${queryString}&signature=${signature}`;

    try {
      const response = await axios.post(url, null, {
        // POST 요청이지만 body는 비어있음
        headers: { 'X-MBX-APIKEY': this.apiKey },
      });
      return this.transformBinanceOrder(response.data);
    } catch (error) {
      const errorMessage = error.response?.data?.msg || error.message;
      this.logger.error(
        `[Binance-REAL] Failed to create order: ${errorMessage}`,
      );
      throw new Error(`Binance API Error: ${errorMessage}`);
    }
  }

  // [구현 완료]
  async getOrder(orderId: string, symbol?: string): Promise<Order> {
    const endpoint = '/api/v3/order';
    const params = {
      symbol: `${symbol.toUpperCase()}USDT`,
      orderId: orderId,
      timestamp: Date.now(),
    };
    const queryString = querystring.stringify(params);
    const signature = this._generateSignature(queryString);
    const url = `${this.serverUrl}${endpoint}?${queryString}&signature=${signature}`;

    try {
      const response = await axios.get(url, {
        headers: { 'X-MBX-APIKEY': this.apiKey },
      });
      return this.transformBinanceOrder(response.data);
    } catch (error) {
      const errorMessage = error.response?.data?.msg || error.message;
      this.logger.error(
        `[Binance-REAL] Failed to get order ${orderId}: ${errorMessage}`,
      );
      throw new Error(`Binance API Error: ${errorMessage}`);
    }
  }

  // [Helper] 바이낸스 주문 응답을 표준 Order 객체로 변환
  private transformBinanceOrder(data: any): Order {
    let status: OrderStatus = 'open';
    if (data.status === 'FILLED') status = 'filled';
    else if (
      data.status === 'CANCELED' ||
      data.status === 'EXPIRED' ||
      data.status === 'REJECTED'
    )
      status = 'canceled';
    else if (data.status === 'PARTIALLY_FILLED') status = 'partially_filled';
    else if (data.status === 'NEW') status = 'open';

    return {
      id: String(data.orderId),
      symbol: data.symbol,
      type: data.type.toLowerCase() as OrderType,
      side: data.side.toLowerCase() as OrderSide,
      price: parseFloat(data.price),
      amount: parseFloat(data.origQty),
      filledAmount: parseFloat(data.executedQty),
      status: status,
      timestamp: new Date(data.time || data.transactTime),
      fee: { currency: '', cost: 0 }, // TODO: 수수료 정보는 별도 조회 또는 계산 필요
    };
  }

  // [구현 완료]
  async getWalletStatus(symbol: string): Promise<WalletStatus> {
    const endpoint = '/sapi/v1/capital/config/getall';
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = this._generateSignature(queryString);
    const url = `${this.serverUrl}${endpoint}?${queryString}&signature=${signature}`;

    try {
      const response = await axios.get<any[]>(url, {
        headers: { 'X-MBX-APIKEY': this.apiKey },
      });

      const targetCoin = response.data.find(
        (c) => c.coin.toUpperCase() === symbol.toUpperCase(),
      );

      if (!targetCoin) {
        throw new Error(`Could not find wallet status for ${symbol}`);
      }

      // 바이낸스는 네트워크별로 상태가 다를 수 있으나, 여기서는 대표 상태를 사용합니다.
      // TODO: 실제 운영 시에는 사용할 특정 네트워크(networkList)의 상태를 확인해야 합니다.
      return {
        currency: targetCoin.coin,
        canDeposit: targetCoin.depositAllEnable,
        canWithdraw: targetCoin.withdrawAllEnable,
        network: targetCoin.networkList[0]?.network || 'N/A',
      };
    } catch (error) {
      const errorMessage = error.response?.data?.msg || error.message;
      this.logger.error(
        `[Binance-REAL] Failed to get wallet status for ${symbol}: ${errorMessage}`,
      );
      throw new Error(`Binance API Error: ${errorMessage}`);
    }
  }

  // [구현 완료]
  async getDepositAddress(
    symbol: string,
  ): Promise<{ address: string; tag?: string; net_type?: string }> {
    const endpoint = '/sapi/v1/capital/deposit/address';
    const params = {
      coin: symbol.toUpperCase(),
      timestamp: Date.now(),
    };
    const queryString = querystring.stringify(params);
    const signature = this._generateSignature(queryString);
    const url = `${this.serverUrl}${endpoint}?${queryString}&signature=${signature}`;

    try {
      const response = await axios.get(url, {
        headers: { 'X-MBX-APIKEY': this.apiKey },
      });
      const data = response.data;
      console.log(data);

      return {
        address: data.address,
        tag: data.tag,
        net_type: data.network || symbol.toUpperCase(),
      };
    } catch (error) {
      const errorMessage = error.response?.data?.msg || error.message;
      this.logger.error(
        `[Binance-REAL] Failed to get deposit address for ${symbol}: ${errorMessage}`,
      );
      throw new Error(`Binance API Error: ${errorMessage}`);
    }
  }

  // [구현 완료]
  async withdraw(
    symbol: string,
    address: string,
    amount: string,
    tag?: string,
    net_type?: string,
  ): Promise<any> {
    const endpoint = '/sapi/v1/capital/withdraw/apply';
    const params: any = {
      coin: symbol.toUpperCase(),
      address: address,
      amount: amount,
      network: net_type,
      timestamp: Date.now(),
    };

    // 데스티네이션 태그가 있는 경우 추가
    if (tag) {
      params.addressTag = tag;
    }

    // TODO: 일부 코인은 network 파라미터가 필수일 수 있습니다.
    // getWalletStatus 응답에서 지원하는 네트워크 목록을 확인하고,
    // 올바른 network 값을 파라미터에 추가하는 로직이 필요합니다.
    // 예: params.network = 'BSC';

    const queryString = querystring.stringify(params);
    const signature = this._generateSignature(queryString);
    const url = `${this.serverUrl}${endpoint}?${queryString}&signature=${signature}`;

    try {
      const response = await axios.post(url, null, {
        headers: { 'X-MBX-APIKEY': this.apiKey },
      });
      this.logger.log(
        `[Binance-REAL] Successfully requested withdrawal for ${amount} ${symbol}. Response:`,
        response.data,
      );
      console.log(response);
      // 출금 요청 결과(id 등)를 반환
      return response.data;
    } catch (error) {
      const errorMessage = error.response?.data?.msg || error.message;
      this.logger.error(
        `[Binance-REAL] Failed to withdraw ${symbol}: ${errorMessage}`,
      );
      throw new Error(`Binance API Error: ${errorMessage}`);
    }
  }

  // [구현 완료]
  async getWithdrawalChance(symbol: string): Promise<WithdrawalChance> {
    const endpoint = '/sapi/v1/capital/config/getall';
    const params = { timestamp: Date.now() };
    const queryString = querystring.stringify(params);
    const signature = this._generateSignature(queryString);
    const url = `${this.serverUrl}${endpoint}?${queryString}&signature=${signature}`;

    try {
      const response = await axios.get<any[]>(url, {
        headers: { 'X-MBX-APIKEY': this.apiKey },
      });
      const targetCoin = response.data.find(
        (c) => c.coin.toUpperCase() === symbol.toUpperCase(),
      );
      if (!targetCoin) {
        throw new Error(`Could not find coin config for ${symbol}`);
      }

      // TODO: 실제 운영 시에는 사용할 특정 네트워크(networkList)를 선택하는 로직이 필요합니다.
      // 여기서는 첫 번째 네트워크를 기본값으로 사용합니다.
      const networkInfo = targetCoin.networkList[0];
      if (!networkInfo) {
        throw new Error(`No network information available for ${symbol}`);
      }

      return {
        currency: symbol,
        fee: parseFloat(networkInfo.withdrawFee || '0'),
        minWithdrawal: parseFloat(networkInfo.withdrawMin || '0'),
      };
    } catch (error) {
      const errorMessage = error.response?.data?.msg || error.message;
      this.logger.error(
        `[Binance-REAL] Failed to get withdrawal chance for ${symbol}: ${errorMessage}`,
      );
      throw new Error(`Binance API Error: ${errorMessage}`);
    }
  }

  // getWithdrawalFee는 getWithdrawalChance로 대체되었으므로, 내부적으로 호출하도록 변경
  async getWithdrawalFee(
    symbol: string,
  ): Promise<{ currency: string; fee: number }> {
    const chance = await this.getWithdrawalChance(symbol);
    return { currency: chance.currency, fee: chance.fee };
  }

  // --- 이하 메소드들은 아직 구현되지 않았습니다 ---

  async getOrderBook(symbol: string): Promise<OrderBook> {
    throw new Error('Binance getOrderBook not implemented.');
  }
}
