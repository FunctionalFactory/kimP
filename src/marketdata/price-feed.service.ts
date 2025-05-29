// src/marketdata/price-feed.service.ts
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import WebSocket from 'ws';
import { Subject } from 'rxjs';
import { ConfigService } from '@nestjs/config';

export interface PriceUpdateData {
  symbol: string;
  exchange: 'upbit' | 'binance';
  price: number;
}

// WsService 등에서 심볼 목록을 가져갈 수 있도록 인터페이스 정의
export interface WatchedSymbolConfig {
  symbol: string;
  upbit: string;
  binance: string;
}

@Injectable()
export class PriceFeedService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PriceFeedService.name);
  private upbitSockets = new Map<string, WebSocket>();
  private binanceSockets = new Map<string, WebSocket>();

  private upbitPrices = new Map<string, number>();
  private binancePrices = new Map<string, number>();

  private readonly _watchedSymbolsConfig: ReadonlyArray<WatchedSymbolConfig>; // ReadonlyArray 사용

  private priceUpdateSubject = new Subject<PriceUpdateData>();
  public priceUpdate$ = this.priceUpdateSubject.asObservable();

  constructor(private readonly configService: ConfigService) {
    // 설정에서 심볼 목록을 가져오거나 기본값 사용
    this._watchedSymbolsConfig = this.configService.get<WatchedSymbolConfig[]>(
      'WATCHED_SYMBOLS',
    ) || [
      { symbol: 'xrp', upbit: 'KRW-XRP', binance: 'xrpusdt' },
      { symbol: 'trx', upbit: 'KRW-TRX', binance: 'trxusdt' },
      { symbol: 'doge', upbit: 'KRW-DOGE', binance: 'dogeusdt' },
      { symbol: 'sol', upbit: 'KRW-SOL', binance: 'solusdt' },
      { symbol: 'matic', upbit: 'KRW-MATIC', binance: 'maticusdt' },
      { symbol: 'algo', upbit: 'KRW-ALGO', binance: 'algousdt' },
      { symbol: 'atom', upbit: 'KRW-ATOM', binance: 'atomusdt' },
      { symbol: 'eos', upbit: 'KRW-EOS', binance: 'eosusdt' },
      { symbol: 'xlm', upbit: 'KRW-XLM', binance: 'xlmusdt' },
      { symbol: 'ada', upbit: 'KRW-ADA', binance: 'adausdt' },
      { symbol: 'dot', upbit: 'KRW-DOT', binance: 'dotusdt' },
      { symbol: 'avax', upbit: 'KRW-AVAX', binance: 'avaxusdt' },
      { symbol: 'ftm', upbit: 'KRW-FTM', binance: 'ftmusdt' },
      { symbol: 'hbar', upbit: 'KRW-HBAR', binance: 'hbarusdt' },
      { symbol: 'zil', upbit: 'KRW-ZIL', binance: 'zilusdt' },
      { symbol: 'vet', upbit: 'KRW-VET', binance: 'vetusdt' },
      { symbol: 'icx', upbit: 'KRW-ICX', binance: 'icxusdt' },
      { symbol: 'qtum', upbit: 'KRW-QTUM', binance: 'qtumusdt' },
      { symbol: 'neo', upbit: 'KRW-NEO', binance: 'neousdt' },
      { symbol: 'btt', upbit: 'KRW-BTT', binance: 'bttcusdt' },
      { symbol: 'mana', upbit: 'KRW-MANA', binance: 'manausdt' },
      { symbol: 'grt', upbit: 'KRW-GRT', binance: 'grtusdt' },
      { symbol: 'lsk', upbit: 'KRW-LSK', binance: 'lskusdt' },
      { symbol: 'ardr', upbit: 'KRW-ARDR', binance: 'ardrusdt' },
    ];
  }

  onModuleInit() {
    this.logger.log(
      'PriceFeedService Initialized. Starting to connect to WebSockets...',
    );
    this.connectToAllFeeds();
  }

  onModuleDestroy() {
    this.logger.log(
      'PriceFeedService Destroyed. Closing all WebSocket connections...',
    );
    this.closeAllSockets();
  }

  // ⭐ Public getter for watched symbols
  public getWatchedSymbols(): ReadonlyArray<WatchedSymbolConfig> {
    return this._watchedSymbolsConfig;
  }

  private connectToAllFeeds() {
    for (const { symbol, upbit, binance } of this._watchedSymbolsConfig) {
      this.connectToUpbit(symbol, upbit);
      this.connectToBinance(symbol, binance);
    }
  }

  public getUpbitPrice(symbol: string): number | undefined {
    return this.upbitPrices.get(symbol);
  }

  public getBinancePrice(symbol: string): number | undefined {
    return this.binancePrices.get(symbol);
  }

  public getAllUpbitPrices(): ReadonlyMap<string, number> {
    return this.upbitPrices;
  }

  public getAllBinancePrices(): ReadonlyMap<string, number> {
    return this.binancePrices;
  }

  private connectToUpbit(symbol: string, market: string) {
    if (this.upbitSockets.has(symbol)) {
      this.logger.warn(
        `[Upbit] WebSocket for ${market} already exists or is connecting.`,
      );
      return;
    }
    const socket = new WebSocket('wss://api.upbit.com/websocket/v1');
    this.upbitSockets.set(symbol, socket);

    socket.on('open', () => {
      this.logger.log(`🟢 [Upbit] Connected for ${market}`);
      const payload = [
        { ticket: `kimP-pricefeed-${symbol}` },
        { type: 'ticker', codes: [market] },
      ];
      socket.send(JSON.stringify(payload));
    });

    socket.on('message', (data) => {
      try {
        const messageString = data.toString('utf8');
        // Upbit에서 PONG 메시지를 보내는 경우가 있으므로, JSON 파싱 전 확인
        if (messageString === 'PONG') {
          // this.logger.debug(`[Upbit] PONG received for ${market}`);
          return;
        }
        const json = JSON.parse(messageString);
        if (json.type === 'ticker' && json.code === market) {
          const price = json.trade_price;
          if (typeof price !== 'number' || isNaN(price)) {
            this.logger.warn(
              `[Upbit ${symbol}] Invalid price received: ${price}`,
            );
            return;
          }
          this.upbitPrices.set(symbol, price);
          this.priceUpdateSubject.next({ symbol, exchange: 'upbit', price });
        }
      } catch (e) {
        this.logger.error(
          `❌ [Upbit ${symbol}] message parse error: ${e instanceof Error ? e.message : e}`,
        );
      }
    });

    socket.on('close', (code, reason) => {
      this.logger.warn(
        `🔌 [Upbit] Disconnected for ${market}. Code: ${code}, Reason: ${reason.toString()}. Reconnecting...`,
      );
      this.upbitSockets.delete(symbol);
      setTimeout(() => this.connectToUpbit(symbol, market), 5000);
    });

    socket.on('error', (err) => {
      this.logger.error(`🔥 [Upbit] ${market} WebSocket Error: ${err.message}`);
      if (
        socket.readyState !== WebSocket.OPEN &&
        socket.readyState !== WebSocket.CONNECTING
      ) {
        this.upbitSockets.delete(symbol);
        setTimeout(() => this.connectToUpbit(symbol, market), 5000);
      }
    });
  }

  private connectToBinance(symbol: string, streamPair: string) {
    if (this.binanceSockets.has(symbol)) {
      this.logger.warn(
        `[Binance] WebSocket for ${streamPair} already exists or is connecting.`,
      );
      return;
    }
    const socket = new WebSocket(
      `wss://stream.binance.com:9443/ws/${streamPair}@ticker`,
    );
    this.binanceSockets.set(symbol, socket);

    socket.on('open', () => {
      this.logger.log(`🟢 [Binance] Connected for ${streamPair}`);
    });

    socket.on('message', (data) => {
      try {
        const raw = data.toString('utf8');
        const json = JSON.parse(raw);
        if (json.e === '24hrTicker') {
          const price = parseFloat(json?.c);
          if (isNaN(price)) {
            // parseFloat은 null/undefined에 대해 NaN 반환
            this.logger.warn(
              `⚠️ [Binance ${symbol}] price invalid or null:`,
              json.c,
            );
            return;
          }
          this.binancePrices.set(symbol, price);
          this.priceUpdateSubject.next({ symbol, exchange: 'binance', price });
        }
      } catch (e) {
        this.logger.error(
          `❌ [Binance ${symbol}] message parse error: ${e instanceof Error ? e.message : e}`,
        );
      }
    });

    socket.on('close', (code, reason) => {
      this.logger.warn(
        `🔌 [Binance] Disconnected for ${streamPair}. Code: ${code}, Reason: ${reason.toString()}. Reconnecting...`,
      );
      this.binanceSockets.delete(symbol);
      setTimeout(() => this.connectToBinance(symbol, streamPair), 5000);
    });

    socket.on('error', (err) => {
      this.logger.error(
        `🔥 [Binance] ${streamPair} WebSocket Error: ${err.message}`,
      );
      if (
        socket.readyState !== WebSocket.OPEN &&
        socket.readyState !== WebSocket.CONNECTING
      ) {
        this.binanceSockets.delete(symbol);
        setTimeout(() => this.connectToBinance(symbol, streamPair), 5000);
      }
    });
  }

  private closeAllSockets() {
    this.upbitSockets.forEach((socket, symbol) => {
      this.logger.log(`Closing Upbit WebSocket for ${symbol}`);
      socket.removeAllListeners();
      socket.terminate();
    });
    this.upbitSockets.clear();

    this.binanceSockets.forEach((socket, symbol) => {
      this.logger.log(`Closing Binance WebSocket for ${symbol}`);
      socket.removeAllListeners();
      socket.terminate();
    });
    this.binanceSockets.clear();
  }
}
