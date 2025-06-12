// src/binance/binance.module.ts
import { Module } from '@nestjs/common';
import { BinanceService } from './binance.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SimulationExchangeService } from '../common/simulation-exchange.service';
import { SimulationModule } from '../common/simulation.module'; // ⭐️ SimulationModule import 추가

// 다른 모듈에서 'BINANCE_EXCHANGE'라는 이름으로 서비스를 주입받기 위한 토큰
export const BINANCE_EXCHANGE_SERVICE = 'BINANCE_EXCHANGE_SERVICE';

@Module({
  imports: [
    ConfigModule,
    SimulationModule, // .env 파일 변수를 읽기 위해 ConfigModule import
  ],
  providers: [
    // 실제 서비스와 시뮬레이션 서비스를 모두 NestJS에 등록
    BinanceService,
    {
      // 'BINANCE_EXCHANGE_SERVICE'라는 이름으로 서비스를 요청하면
      provide: BINANCE_EXCHANGE_SERVICE,
      // 아래 팩토리 로직이 실행되어 상황에 맞는 서비스를 반환
      useFactory: (
        configService: ConfigService,
        binanceService: BinanceService,
        simService: SimulationExchangeService,
      ) => {
        const mode = configService.get('BINANCE_MODE');
        if (mode === 'SIMULATION') {
          return simService;
        }
        // 기본값은 실제 거래
        return binanceService;
      },
      // 팩토리에서 사용할 서비스들을 주입
      inject: [ConfigService, BinanceService, SimulationExchangeService],
    },
  ],
  // 다른 모듈에서 BINANCE_EXCHANGE_SERVICE를 사용할 수 있도록 export
  exports: [BINANCE_EXCHANGE_SERVICE],
})
export class BinanceModule {}
