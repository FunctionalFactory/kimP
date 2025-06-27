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
  OrderBookLevel,
  TickerInfo,
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
  private readonly futuresServerUrl = 'https://fapi.binance.com';
  private symbolInfoCache = new Map<string, any>();
  private futuresSymbolInfoCache = new Map<string, any>();

  constructor(private readonly configService: ConfigService) {
    this.logger.error('<<<<< BinanceService (REAL) IS LOADED >>>>>');

    this.apiKey = this.configService.get<string>('BINANCE_API_KEY');
    this.secretKey = this.configService.get<string>('BINANCE_SECRET_KEY');

    if (!this.apiKey || !this.secretKey) {
      this.logger.error('Binance API Key is missing. Please check .env file.');
    } else {
      this.logger.log('BinanceService (REAL) has been initialized.');
    }
    this.initializeFuturesSettings();
  }
  // <<<< 신규 추가: 서비스 시작 시 모든 감시 대상 코인에 대해 1배율로 설정 >>>>
  private async initializeFuturesSettings() {
    // 이 부분은 실제 운영 시 WATCHED_SYMBOLS 목록을 가져와서 처리해야 합니다.
    // 여기서는 예시로 XRP만 처리합니다.
    const symbolsToHedge = ['XRP', 'TRX', 'DOGE']; // 실제로는 ConfigService 등에서 관리
    this.logger.log('[HEDGE_INIT] 선물 헷지 설정 초기화를 시작합니다...');
    for (const symbol of symbolsToHedge) {
      try {
        await this.setLeverage(symbol, 1);
      } catch (error) {
        this.logger.error(
          `[HEDGE_INIT] ${symbol} 레버리지 설정 실패: ${error.message}`,
        );
      }
    }
  }

  private async _getFuturesSymbolInfo(symbol: string): Promise<any> {
    const market = `${this.getExchangeTicker(symbol).toUpperCase()}USDT`;
    if (this.futuresSymbolInfoCache.has(market)) {
      return this.futuresSymbolInfoCache.get(market);
    }

    try {
      this.logger.log(
        `[FUTURES_INFO] Fetching futures exchange info for ${market}...`,
      );
      const response = await axios.get(
        `${this.futuresServerUrl}/fapi/v1/exchangeInfo`,
      );
      const allSymbols = response.data.symbols;
      // 모든 심볼 정보를 캐시에 저장하여 반복적인 API 호출을 방지
      allSymbols.forEach((s) => this.futuresSymbolInfoCache.set(s.symbol, s));

      const symbolInfo = this.futuresSymbolInfoCache.get(market);

      if (symbolInfo) {
        return symbolInfo;
      } else {
        throw new Error(`Futures symbol info for ${market} not found.`);
      }
    } catch (error) {
      this.logger.error(
        `Failed to fetch futures exchange info: ${error.message}`,
      );
      throw error;
    }
  }

  // <<<< 신규 추가: 선물 레버리지 설정을 위한 내부 메소드 >>>>
  private async setLeverage(symbol: string, leverage: number): Promise<any> {
    const endpoint = '/fapi/v1/leverage';
    const params = {
      symbol: `${symbol.toUpperCase()}USDT`,
      leverage,
      timestamp: Date.now(),
    };
    const queryString = querystring.stringify(params);
    const signature = this._generateSignature(queryString);
    const url = `${this.futuresServerUrl}${endpoint}?${queryString}&signature=${signature}`;

    try {
      const response = await axios.post(url, null, {
        headers: { 'X-MBX-APIKEY': this.apiKey },
      });
      this.logger.log(
        `[HEDGE_INIT] ${symbol} 레버리지를 ${leverage}x로 설정했습니다.`,
      );
      return response.data;
    } catch (error) {
      const errorMessage = error.response?.data?.msg || error.message;
      this.logger.error(`[HEDGE_INIT] 레버리지 설정 API 오류: ${errorMessage}`);
      throw new Error(`Binance API Error: ${errorMessage}`);
    }
  }

  public getExchangeTicker(symbol: string): string {
    const upperSymbol = symbol.toUpperCase();
    if (upperSymbol === 'BTT') {
      return 'BTTC';
    }
    return upperSymbol;
  }

  private async _getSymbolInfo(symbol: string): Promise<any> {
    const market = `${this.getExchangeTicker(symbol).toUpperCase()}USDT`;
    if (this.symbolInfoCache.has(market)) {
      return this.symbolInfoCache.get(market);
    }

    try {
      this.logger.log(`Fetching exchange info for ${market}...`);
      const response = await axios.get(`${this.serverUrl}/api/v3/exchangeInfo`);
      const allSymbols = response.data.symbols;
      const symbolInfo = allSymbols.find((s: any) => s.symbol === market);

      if (symbolInfo) {
        this.symbolInfoCache.set(market, symbolInfo);
        return symbolInfo;
      } else {
        throw new Error(`Symbol info for ${market} not found.`);
      }
    } catch (error) {
      this.logger.error(`Failed to fetch exchange info: ${error.message}`);
      throw error;
    }
  }

  // 숫자를 특정 정밀도(stepSize)에 맞게 조정하는 헬퍼 메소드
  private _adjustToStepSize(value: number, stepSize: string): number {
    const precision = Math.max(stepSize.indexOf('1') - 1, 0);
    return parseFloat(value.toFixed(precision));
  }

  /**
   * ⭐️ [추가] 코인 심볼에 맞는 실제 네트워크 타입을 반환하는 헬퍼 함수
   * @param symbol 코인 심볼 (e.g., 'BTT', 'XRP')
   * @returns 실제 네트워크 타입 (e.g., 'TRX', 'XRP')
   */
  private getNetworkType(symbol: string): string {
    const upperSymbol = symbol.toUpperCase();
    const networkMap: { [key: string]: string } = {
      BTTC: 'TRX',
      XRP: 'XRP',
      GRT: 'ETH',
      MANA: 'ETH',
      NEO: 'NEO3',
      QTUM: 'QTUM',
      VET: 'VET',
      ZIL: 'ZIL',
      AVAX: 'AVAXC',
      ATOM: 'ATOM',
      ADA: 'ADA',
      ALGO: 'ALGO',
      DOT: 'DOT',
      NEWT: 'ETH',
      W: 'ETH',
      APT: 'APT',
      ONDO: 'ETH',
      SHIB: 'ETH',
      SUI: 'SUI',
      UNI: 'ETH',
      SEI: 'SEI',
      PEPE: 'ETH',
      LAYER: 'ETH',
      TRUMP: 'ETH',
      SAHARA: 'ETH',
      MOVE: 'ETH',
      ARDR: 'ETH',
      // USDT를 트론 네트워크로 보내고 싶을 경우
      // USDT: 'TRX',
    };
    return networkMap[upperSymbol] || upperSymbol;
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

  /**
   * [수정] 시장가 매수 시, 수량이 아닌 총액(quoteOrderQty)으로 주문할 수 있도록 수정합니다.
   * 이는 "100 USDT 만큼 구매"와 같은 요청을 처리하기 위함입니다.
   * `createOrder`의 `price` 파라미터를 시장가 매수 시에는 '총액'으로 사용하기로 약속합니다.
   */
  async createOrder(
    symbol: string,
    type: OrderType,
    side: OrderSide,
    amount?: number, // 시장가 매수 시에는 이 값을 사용하지 않을 수 있으므로 optional로 변경
    price?: number,
  ): Promise<Order> {
    const exchangeTicker = this.getExchangeTicker(symbol); // ✨ 헬퍼 함수 호출 추가
    const endpoint = '/api/v3/order';

    const symbolInfo = await this._getSymbolInfo(symbol);
    const priceFilter = symbolInfo.filters.find(
      (f: any) => f.filterType === 'PRICE_FILTER',
    );
    const lotSizeFilter = symbolInfo.filters.find(
      (f: any) => f.filterType === 'LOT_SIZE',
    );

    const params: any = {
      symbol: `${exchangeTicker.toUpperCase()}USDT`,
      side: side.toUpperCase(),
      type: type.toUpperCase(),
      timestamp: Date.now(),
    };

    if (type === 'limit') {
      params.timeInForce = 'GTC';

      const tickSize = priceFilter.tickSize;
      const stepSize = lotSizeFilter.stepSize;

      params.price = this._adjustToStepSize(price, tickSize);
      params.quantity = this._adjustToStepSize(amount, stepSize);

      this.logger.log(
        `Adjusted order params: Price ${price} -> ${params.price}, Amount ${amount} -> ${params.quantity}`,
      );
    } else if (type === 'market') {
      if (side === 'buy') {
        // 시장가 매수: 'price' 파라미터에 담겨온 총액(USDT)을 quoteOrderQty로 사용
        if (!price || price <= 0) {
          throw new Error(
            'For market buy, total cost (price) must be provided.',
          );
        }
        params.quoteOrderQty = price;
      } else {
        // 시장가 매도: 'amount' 파라미터에 담겨온 수량을 quantity로 사용
        if (!amount || amount <= 0) {
          throw new Error(
            'For market sell, quantity (amount) must be provided.',
          );
        }
        params.quantity = amount;
      }
    }

    const queryString = querystring.stringify(params);
    const signature = this._generateSignature(queryString);
    const url = `${this.serverUrl}${endpoint}?${queryString}&signature=${signature}`;

    try {
      const response = await axios.post(url, null, {
        headers: { 'X-MBX-APIKEY': this.apiKey },
      });
      if (response.data.code) {
        this.logger.error(
          `[Binance-REAL] Order creation failed with soft error:`,
          response.data,
        );
        throw new Error(
          `Binance API Error: ${response.data.msg} (Code: ${response.data.code})`,
        );
      }
      if (!response.data.orderId) {
        this.logger.error(
          '[Binance-REAL] API response did not contain an orderId.',
          response.data,
        );
        throw new Error(
          'Binance API did not return an orderId in the response.',
        );
      }
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
      const exchangeTicker = this.getExchangeTicker(symbol).toUpperCase(); // ✨ 헬퍼 함수 호출 추가
      const targetCoin = response.data.find(
        (c) => c.coin.toUpperCase() === exchangeTicker,
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
    const ticker = this.getExchangeTicker(symbol);

    const endpoint = '/sapi/v1/capital/deposit/address';
    const params = {
      coin: ticker,
      network: this.getNetworkType(ticker), // ⭐️ 수정: 특정 네트워크 주소 요청
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
    net_type?: string,
    tag?: string,
  ): Promise<any> {
    const endpoint = '/sapi/v1/capital/withdraw/apply';

    const networkToUse = net_type || this.getNetworkType(symbol.toUpperCase());
    this.logger.log(
      `출금 요청: ${symbol} 코인을 ${networkToUse} 네트워크로 전송합니다.`,
    );

    const params: any = {
      coin: symbol.toUpperCase(),
      address: address,
      amount: amount,
      network: networkToUse, // 결정된 네트워크 값을 사용합니다.
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
      const exchangeTicker = this.getExchangeTicker(symbol).toUpperCase(); // ✨ 헬퍼 함수 호출 추가
      const targetCoin = response.data.find(
        (c) => c.coin.toUpperCase() === exchangeTicker,
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
    const endpoint = '/api/v3/depth';
    const exchangeTicker = this.getExchangeTicker(symbol).toUpperCase();
    const url = `${this.serverUrl}${endpoint}?symbol=${exchangeTicker}USDT&limit=20`;

    try {
      const response = await axios.get(url);
      const data = response.data;

      // 바이낸스 응답을 표준 OrderBook 형태로 변환
      const bids: OrderBookLevel[] = data.bids.map((b: [string, string]) => ({
        price: parseFloat(b[0]),
        amount: parseFloat(b[1]),
      }));

      const asks: OrderBookLevel[] = data.asks.map((a: [string, string]) => ({
        price: parseFloat(a[0]),
        amount: parseFloat(a[1]),
      }));

      return {
        symbol: `${exchangeTicker}USDT`,
        bids,
        asks,
        timestamp: new Date(), // 바이낸스는 별도 타임스탬프를 안주므로 현재 시각 사용
      };
    } catch (error) {
      const errorMessage = error.response?.data?.msg || error.message;
      this.logger.error(
        `[Binance-REAL] Failed to get order book for ${symbol}: ${errorMessage}`,
      );
      throw new Error(`Binance API Error: ${errorMessage}`);
    }
  }

  async getTickerInfo(symbol: string): Promise<TickerInfo> {
    const endpoint = '/api/v3/ticker/24hr';
    const exchangeTicker = this.getExchangeTicker(symbol).toUpperCase();
    const url = `${this.serverUrl}${endpoint}?symbol=${exchangeTicker}USDT`;

    try {
      const response = await axios.get(url);
      const data = response.data;

      return {
        symbol: data.symbol,
        quoteVolume: parseFloat(data.quoteVolume), // 바이낸스는 'quoteVolume'이 24시간 누적 거래대금(USDT)
      };
    } catch (error) {
      const errorMessage = error.response?.data?.msg || error.message;
      this.logger.error(
        `[Binance-REAL] Failed to get ticker info for ${symbol}: ${errorMessage}`,
      );
      throw new Error(`Binance API Error: ${errorMessage}`);
    }
  }

  async cancelOrder(orderId: string, symbol: string): Promise<any> {
    const endpoint = '/api/v3/order';
    const params = {
      symbol: `${this.getExchangeTicker(symbol).toUpperCase()}USDT`,
      orderId: orderId,
      timestamp: Date.now(),
    };
    const queryString = querystring.stringify(params);
    const signature = this._generateSignature(queryString);
    const url = `${this.serverUrl}${endpoint}?${queryString}&signature=${signature}`;

    try {
      const response = await axios.delete(url, {
        headers: { 'X-MBX-APIKEY': this.apiKey },
      });
      this.logger.log(
        `[Binance-REAL] Order ${orderId} for ${symbol} cancellation requested successfully.`,
      );
      return response.data;
    } catch (error) {
      const errorMessage = error.response?.data?.msg || error.message;
      this.logger.error(
        `[Binance-REAL] Failed to cancel order ${orderId}: ${errorMessage}`,
      );
      throw new Error(`Binance API Error: ${errorMessage}`);
    }
  }

  async createFuturesOrder(
    symbol: string,
    side: OrderSide,
    type: OrderType,
    amount: number,
    price?: number,
  ): Promise<Order> {
    // 1. 선물 시장의 거래 규칙을 조회합니다.
    const symbolInfo = await this._getFuturesSymbolInfo(symbol);
    const quantityPrecision = symbolInfo.quantityPrecision; // 허용되는 소수점 자릿수

    if (quantityPrecision === undefined) {
      throw new Error(
        `Could not determine quantityPrecision for ${symbol} futures.`,
      );
    }

    // 2. 주문 수량을 선물 시장의 정밀도에 맞게 조정합니다.
    const adjustedAmount = parseFloat(amount.toFixed(quantityPrecision));
    this.logger.log(
      `[FUTURES_ORDER] 수량 정밀도 조정: Raw: ${amount} -> Adjusted: ${adjustedAmount}`,
    );

    // 조정된 수량이 0 이하면 주문 불가
    if (adjustedAmount <= 0) {
      throw new Error(
        `Adjusted quantity (${adjustedAmount}) is too small to place a futures order.`,
      );
    }

    const endpoint = '/fapi/v1/order';
    const params: any = {
      symbol: `${symbol.toUpperCase()}USDT`,
      side: side.toUpperCase(),
      type: type.toUpperCase(),
      quantity: adjustedAmount, // ◀︎◀︎ 조정된 수량을 사용
      timestamp: Date.now(),
    };

    if (type.toUpperCase() === 'LIMIT') {
      if (!price) throw new Error('Limit order requires a price.');
      // 가격 정밀도 조정도 필요 시 추가 가능 (pricePrecision 사용)
      params.price = price;
      params.timeInForce = 'GTC';
    }

    const queryString = querystring.stringify(params);
    const signature = this._generateSignature(queryString);
    const url = `${this.futuresServerUrl}${endpoint}?${queryString}&signature=${signature}`;

    try {
      const response = await axios.post(url, null, {
        headers: { 'X-MBX-APIKEY': this.apiKey },
      });
      return this.transformBinanceOrder(response.data);
    } catch (error) {
      const errorMessage = error.response?.data?.msg || error.message;
      this.logger.error(
        `[Binance-FUTURES] 선물 주문 생성 실패: ${errorMessage}`,
      );
      throw new Error(`Binance API Error: ${errorMessage}`);
    }
  }

  async internalTransfer(
    asset: string,
    amount: number,
    from: 'SPOT' | 'UMFUTURE',
    to: 'SPOT' | 'UMFUTURE',
  ): Promise<any> {
    // 바이낸스 API에서 사용하는 이체 타입 코드
    // 현물 -> 선물: 1, 선물 -> 현물: 2
    let transferType: string;
    // 바이낸스 API가 요구하는 정확한 문자열 타입으로 변환
    if (from === 'SPOT' && to === 'UMFUTURE') {
      transferType = 'MAIN_UMFUTURE'; // 현물 -> 선물
    } else if (from === 'UMFUTURE' && to === 'SPOT') {
      transferType = 'UMFUTURE_MAIN'; // 선물 -> 현물
    } else {
      throw new Error('Unsupported transfer direction');
    }

    const adjustedAmount = parseFloat(amount.toFixed(8));

    const endpoint = '/sapi/v1/asset/transfer';

    const params = {
      asset,
      amount: adjustedAmount,
      type: transferType,
      timestamp: Date.now(),
    };

    const queryString = querystring.stringify(params);
    const signature = this._generateSignature(queryString);
    const url = `${this.serverUrl}${endpoint}?${queryString}&signature=${signature}`;

    try {
      const response = await axios.post(url, null, {
        headers: { 'X-MBX-APIKEY': this.apiKey },
      });
      this.logger.log(
        `[TRANSFER] ${amount} ${asset}를 ${from}에서 ${to}로 이체 완료. TransId: ${response.data.tranId}`,
      );
      return response.data;
    } catch (error) {
      const errorMessage = error.response?.data?.msg || error.message;
      this.logger.error(`[TRANSFER_FAIL] 자산 이체 실패: ${errorMessage}`);
      throw new Error(`Binance API Error: ${errorMessage}`);
    }
  }

  async getFuturesBalances(
    walletType: 'SPOT' | 'UMFUTURE',
  ): Promise<Balance[]> {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = this._generateSignature(queryString);

    try {
      let url: string;
      if (walletType === 'UMFUTURE') {
        // 선물 지갑 잔고 조회
        url = `${this.futuresServerUrl}/fapi/v2/account?${queryString}&signature=${signature}`;
      } else {
        // 현물 지갑 잔고 조회 (기존 getBalances와 동일)
        url = `${this.serverUrl}/api/v3/account?${queryString}&signature=${signature}`;
      }

      const response = await axios.get(url, {
        headers: { 'X-MBX-APIKEY': this.apiKey },
      });

      if (walletType === 'UMFUTURE') {
        // 선물 지갑 응답 처리
        const balances = response.data.assets || [];
        return balances
          .filter((asset: any) => parseFloat(asset.walletBalance) > 0)
          .map((asset: any) => ({
            currency: asset.asset,
            balance: parseFloat(asset.walletBalance),
            locked: parseFloat(asset.maintMargin),
            available: parseFloat(asset.availableBalance),
          }));
      } else {
        // 현물 지갑 응답 처리 (기존과 동일)
        const balances = response.data.balances || [];
        return balances
          .filter(
            (balance: any) =>
              parseFloat(balance.free) > 0 || parseFloat(balance.locked) > 0,
          )
          .map((balance: any) => ({
            currency: balance.asset,
            balance: parseFloat(balance.free) + parseFloat(balance.locked),
            locked: parseFloat(balance.locked),
            available: parseFloat(balance.free),
          }));
      }
    } catch (error) {
      const errorMessage = error.response?.data?.msg || error.message;
      this.logger.error(
        `[FUTURES_BALANCE_FAIL] 선물 잔고 조회 실패: ${errorMessage}`,
      );
      throw new Error(`Binance API Error: ${errorMessage}`);
    }
  }
}
