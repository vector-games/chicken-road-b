import { Module } from '@nestjs/common';
import { RefundSchedulerService } from './refund-scheduler.service';
import { BetModule } from '../bet/bet.module';
import { RedisModule } from '../redis/redis.module';
import { WalletConfigModule } from '../wallet-config/wallet-config.module';
import { GameModule } from '../games/game.module';

@Module({
  imports: [BetModule, RedisModule, WalletConfigModule, GameModule],
  providers: [RefundSchedulerService],
  exports: [RefundSchedulerService],
})
export class RefundSchedulerModule {}

