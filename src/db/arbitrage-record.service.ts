// src/db/arbitrage-record.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ArbitrageCycle } from './entities/arbitrage-cycle.entity';

@Injectable()
export class ArbitrageRecordService {
  private readonly logger = new Logger(ArbitrageRecordService.name);

  constructor(
    @InjectRepository(ArbitrageCycle)
    private readonly arbitrageCycleRepository: Repository<ArbitrageCycle>,
  ) {}

  async createArbitrageCycle(
    data: Partial<ArbitrageCycle>,
  ): Promise<ArbitrageCycle> {
    const newCycle = this.arbitrageCycleRepository.create(data);
    newCycle.status = 'STARTED'; // 초기 상태
    const savedCycle = await this.arbitrageCycleRepository.save(newCycle);
    this.logger.log(`새로운 차익거래 사이클 시작: ${savedCycle.id}`);
    return savedCycle;
  }

  async updateArbitrageCycle(
    id: string,
    data: Partial<ArbitrageCycle>,
  ): Promise<ArbitrageCycle> {
    const cycle = await this.arbitrageCycleRepository.findOne({
      where: { id },
    });
    if (!cycle) {
      this.logger.error(`ID ${id}를 가진 차익거래 사이클을 찾을 수 없습니다.`);
      throw new Error(`Arbitrage cycle with ID ${id} not found.`);
    }
    Object.assign(cycle, data);
    const updatedCycle = await this.arbitrageCycleRepository.save(cycle);
    this.logger.log(
      `차익거래 사이클 업데이트: ${updatedCycle.id}, 상태: ${updatedCycle.status}`,
    );
    return updatedCycle;
  }

  async getArbitrageCycle(id: string): Promise<ArbitrageCycle | null> {
    return this.arbitrageCycleRepository.findOne({ where: { id } });
  }

  // 필요한 경우 다른 조회 메서드 추가
}
