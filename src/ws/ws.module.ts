// src/ws/ws.module.ts
import { Module } from '@nestjs/common';
import { WsService } from './ws.service';
import { MarketDataModule } from '../marketdata/marketdata.module'; // PriceFeedService 제공
import { ArbitrageModule } from '../arbitrage/arbitrage.module'; // ArbitrageFlowManagerService 제공
import { SessionModule } from '../session/session.module'; // SessionManagerService 제공

@Module({
  imports: [
    MarketDataModule, // PriceFeedService를 WsService에 주입하기 위해
    ArbitrageModule, // ArbitrageFlowManagerService를 WsService에 주입하기 위해
    SessionModule, // SessionManagerService를 WsService에 주입하기 위해
  ],
  providers: [
    WsService,
    // WsService가 더 이상 직접 사용하지 않는 서비스들은 여기서 제거
  ],
  // WsService가 onModuleInit을 통해 자체적으로 동작을 시작하므로,
  // AppModule 등에서 직접 WsService를 호출할 필요가 없다면 exports는 불필요할 수 있습니다.
  // 하지만 명시적으로 export 해두는 것도 좋습니다.
  exports: [WsService],
})
export class WsModule {}
