// src/marketdata/price-feed.service.ts
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import WebSocket from 'ws';
import { Subject, BehaviorSubject } from 'rxjs';
import { ConfigService } from '@nestjs/config';

export interface PriceUpdateData {
  symbol: string;
  exchange: 'upbit' | 'binance';
  price: number;
}

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

  private readonly _watchedSymbolsConfig: ReadonlyArray<WatchedSymbolConfig>;

  private priceUpdateSubject = new Subject<PriceUpdateData>();
  public priceUpdate$ = this.priceUpdateSubject.asObservable();

  // --- [추가된 부분] ---
  private allConnectionsEstablished = new BehaviorSubject<boolean>(false);
  public allConnectionsEstablished$ =
    this.allConnectionsEstablished.asObservable();
  private connectedSockets = new Set<string>();
  private totalRequiredConnections = 0;
  // --- [추가 끝] ---

  constructor(private readonly configService: ConfigService) {
    this._watchedSymbolsConfig = this.configService.get<WatchedSymbolConfig[]>(
      'WATCHED_SYMBOLS',
    ) || [
      { symbol: 'xrp', upbit: 'KRW-XRP', binance: 'xrpusdt' },
      { symbol: 'trx', upbit: 'KRW-TRX', binance: 'trxusdt' },
      { symbol: 'doge', upbit: 'KRW-DOGE', binance: 'dogeusdt' }, //
      { symbol: 'sol', upbit: 'KRW-SOL', binance: 'solusdt' }, //
      { symbol: 'algo', upbit: 'KRW-ALGO', binance: 'algousdt' }, //
      // { symbol: 'atom', upbit: 'KRW-ATOM', binance: 'atomusdt' }, //
      { symbol: 'ada', upbit: 'KRW-ADA', binance: 'adausdt' }, //
      { symbol: 'dot', upbit: 'KRW-DOT', binance: 'dotusdt' }, //
      { symbol: 'avax', upbit: 'KRW-AVAX', binance: 'avaxusdt' }, //
      // { symbol: 'hbar', upbit: 'KRW-HBAR', binance: 'hbarusdt' },
      { symbol: 'zil', upbit: 'KRW-ZIL', binance: 'zilusdt' }, //
      { symbol: 'vet', upbit: 'KRW-VET', binance: 'vetusdt' }, //
      { symbol: 'icx', upbit: 'KRW-ICX', binance: 'icxusdt' }, //
      { symbol: 'qtum', upbit: 'KRW-QTUM', binance: 'qtumusdt' }, //
      { symbol: 'neo', upbit: 'KRW-NEO', binance: 'neousdt' }, //
      // { symbol: 'btt', upbit: 'KRW-BTT', binance: 'bttcusdt' }, //
      { symbol: 'mana', upbit: 'KRW-MANA', binance: 'manausdt' }, //
      { symbol: 'grt', upbit: 'KRW-GRT', binance: 'grtusdt' }, //
      { symbol: 'ardr', upbit: 'KRW-ARDR', binance: 'ardrusdt' }, //
    ];
    this.totalRequiredConnections = this._watchedSymbolsConfig.length * 2;
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

  public getWatchedSymbols(): ReadonlyArray<WatchedSymbolConfig> {
    return this._watchedSymbolsConfig;
  }

  private checkAndEmitConnectionStatus() {
    const isReady =
      this.connectedSockets.size === this.totalRequiredConnections;
    if (this.allConnectionsEstablished.getValue() !== isReady) {
      this.allConnectionsEstablished.next(isReady);
      if (isReady) {
        this.logger.log(
          '✅ All WebSocket connections established. System is ready.',
        );
      } else {
        this.logger.warn(
          '🔌 A WebSocket connection was lost. System is not ready.',
        );
      }
    }
  }

  private async connectToAllFeeds() {
    for (const { symbol, upbit, binance } of this._watchedSymbolsConfig) {
      // 각 거래소 연결을 동시에 시작하되, 다음 코인 쌍으로 넘어가기 전에 지연
      this.connectToUpbit(symbol, upbit);
      this.connectToBinance(symbol, binance);
      // 250ms 지연으로 서버에 부담을 주지 않음
      await new Promise((resolve) => setTimeout(resolve, 250));
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
      this.connectedSockets.add(`upbit-${symbol}`);
      this.checkAndEmitConnectionStatus();
      const payload = [
        { ticket: `kimP-pricefeed-${symbol}` },
        { type: 'ticker', codes: [market] },
      ];
      socket.send(JSON.stringify(payload));
    });

    socket.on('message', (data) => {
      try {
        const messageString = data.toString('utf8');
        if (messageString === 'PONG') {
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
      this.connectedSockets.delete(`upbit-${symbol}`);
      this.checkAndEmitConnectionStatus();
      this.upbitSockets.delete(symbol);
      setTimeout(() => this.connectToUpbit(symbol, market), 5000);
    });

    socket.on('error', (err) => {
      this.logger.error(`🔥 [Upbit] ${market} WebSocket Error: ${err.message}`);
      // 'close' 이벤트가 항상 뒤따르므로 여기서 재연결 로직을 중복 실행할 필요 없음
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
      this.connectedSockets.add(`binance-${symbol}`);
      this.checkAndEmitConnectionStatus();
    });

    socket.on('message', (data) => {
      try {
        const raw = data.toString('utf8');
        const json = JSON.parse(raw);
        if (json.e === '24hrTicker') {
          const price = parseFloat(json?.c);
          if (isNaN(price)) {
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
      this.connectedSockets.delete(`binance-${symbol}`);
      this.checkAndEmitConnectionStatus();
      this.binanceSockets.delete(symbol);
      setTimeout(() => this.connectToBinance(symbol, streamPair), 5000);
    });

    socket.on('error', (err) => {
      this.logger.error(
        `🔥 [Binance] ${streamPair} WebSocket Error: ${err.message}`,
      );
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
