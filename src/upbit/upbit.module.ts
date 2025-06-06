import { Module } from '@nestjs/common';
import { UpbitService } from './upbit.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SimulationExchangeService } from '../common/simulation-exchange.service';

// 다른 모듈에서 'UPBIT_EXCHANGE'라는 이름으로 서비스를 주입받기 위한 토큰
export const UPBIT_EXCHANGE_SERVICE = 'UPBIT_EXCHANGE_SERVICE';

@Module({
  imports: [ConfigModule], // .env 파일 변수를 읽기 위해 ConfigModule import
  providers: [
    // 실제 서비스와 시뮬레이션 서비스를 모두 NestJS에 등록
    UpbitService,
    SimulationExchangeService,
    {
      // 'UPBIT_EXCHANGE_SERVICE'라는 이름으로 서비스를 요청하면
      provide: UPBIT_EXCHANGE_SERVICE,
      // 아래 팩토리 로직이 실행되어 상황에 맞는 서비스를 반환
      useFactory: (
        configService: ConfigService,
        upbitService: UpbitService,
        simService: SimulationExchangeService,
      ) => {
        const mode = configService.get('UPBIT_MODE');
        if (mode === 'SIMULATION') {
          return simService;
        }
        // 기본값은 실제 거래
        return upbitService;
      },
      // 팩토리에서 사용할 서비스들을 주입
      inject: [ConfigService, UpbitService, SimulationExchangeService],
    },
  ],
  // 다른 모듈에서 UPBIT_EXCHANGE_SERVICE를 사용할 수 있도록 export
  exports: [UPBIT_EXCHANGE_SERVICE],
})
export class UpbitModule {}
