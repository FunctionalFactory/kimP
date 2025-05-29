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
  private priceUpdateSubscription: Subscription | null = null;

  constructor(
    private readonly priceFeedService: PriceFeedService,
    private readonly arbitrageFlowManagerService: ArbitrageFlowManagerService,
  ) {}

  onModuleInit() {
    this.logger.log(
      'WsService Initialized. Subscribing to price updates from PriceFeedService.',
    );
    // PriceFeedService의 onModuleInit에서 웹소켓 연결이 시작됩니다.
    // WsService는 PriceFeedService가 발행하는 가격 업데이트 이벤트를 구독합니다.
    this.priceUpdateSubscription = this.priceFeedService.priceUpdate$.subscribe(
      (priceData: PriceUpdateData) => {
        // ArbitrageFlowManagerService.handlePriceUpdate 내부에서 양쪽 거래소 가격을 확인합니다.
        // handlePriceUpdate는 비동기 함수이므로 await을 사용하거나, .then().catch()로 처리할 수 있습니다.
        // 여기서는 백그라운드에서 실행되도록 하고, 오류는 handlePriceUpdate 내부에서 로깅되도록 합니다.
        this.arbitrageFlowManagerService
          .handlePriceUpdate(priceData.symbol)
          .catch((error) => {
            this.logger.error(
              `Error during handlePriceUpdate for symbol ${priceData.symbol}: ${error.message}`,
              error.stack,
            );
          });
      },
      (error) => {
        this.logger.error(
          'Error in price update subscription in WsService:',
          error.message,
          error.stack,
        );
        // 필요시 재구독 로직 또는 더 구체적인 오류 처리
      },
    );
  }

  onModuleDestroy() {
    this.logger.log('WsService Destroyed. Unsubscribing from price updates.');
    if (this.priceUpdateSubscription) {
      this.priceUpdateSubscription.unsubscribe();
    }
    // PriceFeedService의 onModuleDestroy에서 웹소켓 연결이 정리됩니다.
  }
}
