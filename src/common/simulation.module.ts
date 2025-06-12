// src/common/simulation.module.ts
import { Module } from '@nestjs/common';
import { SimulationExchangeService } from './simulation-exchange.service';

@Module({
  providers: [SimulationExchangeService],
  exports: [SimulationExchangeService], // 다른 모듈에서 사용할 수 있도록 export
})
export class SimulationModule {}
