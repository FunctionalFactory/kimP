// src/ws/ws.service.ts
import {
  Injectable,
  OnModuleInit,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { Subscription } from 'rxjs';
import {
  PriceFeedService,
  PriceUpdateData,
} from '../marketdata/price-feed.service';
import { ArbitrageFlowManagerService } from '../arbitrage/arbitrage-flow-manager.service';

@Injectable()
export class WsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WsService.name);

  private connectionStatusSubscription: Subscription | null = null;
  private priceUpdateSubscription: Subscription | null = null;

  constructor(
    private readonly priceFeedService: PriceFeedService,
    private readonly arbitrageFlowManagerService: ArbitrageFlowManagerService,
  ) {}

  onModuleInit() {
    this.logger.log(
      'WsService Initialized. Subscribing to connection status...',
    );

    // 1. PriceFeedService의 전체 연결 상태를 구독합니다.
    this.connectionStatusSubscription =
      this.priceFeedService.allConnectionsEstablished$.subscribe((isReady) => {
        if (isReady) {
          // 2. 모든 연결이 준비되면, 가격 업데이트 구독을 시작합니다.
          // 이미 구독중이 아닐 때만 새로 구독합니다.
          if (
            !this.priceUpdateSubscription ||
            this.priceUpdateSubscription.closed
          ) {
            this.logger.log(
              'All connections are ready. Starting to listen for price updates.',
            );
            this.priceUpdateSubscription =
              this.priceFeedService.priceUpdate$.subscribe({
                next: (priceData: PriceUpdateData) => {
                  this.arbitrageFlowManagerService
                    .handlePriceUpdate(priceData.symbol)
                    .catch((error) => {
                      this.logger.error(
                        `Error during handlePriceUpdate for symbol ${priceData.symbol}: ${error.message}`,
                        error.stack,
                      );
                    });
                },
                error: (error) => {
                  this.logger.error(
                    'Error in price update subscription:',
                    error.message,
                    error.stack,
                  );
                },
              });
          }
        } else {
          // 3. 연결이 하나라도 끊기면, 가격 업데이트 구독을 중단하여 로직 실행을 막습니다.
          if (
            this.priceUpdateSubscription &&
            !this.priceUpdateSubscription.closed
          ) {
            this.logger.warn(
              'Connections are not ready. Pausing price update listener.',
            );
            this.priceUpdateSubscription.unsubscribe();
          }
        }
      });
  }

  onModuleDestroy() {
    this.logger.log('WsService Destroyed. Unsubscribing from all updates.');
    if (this.connectionStatusSubscription) {
      this.connectionStatusSubscription.unsubscribe();
    }
    if (this.priceUpdateSubscription) {
      this.priceUpdateSubscription.unsubscribe();
    }
  }
}
