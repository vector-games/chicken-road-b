import { HttpModule } from '@nestjs/axios';
import { Module, forwardRef } from '@nestjs/common';
import { AgentsModule, BetModule, WalletAuditModule, WalletRetryModule } from '@vector-games/game-core';
import { GameConfigModule } from '../../modules/gameConfig/game-config.module';
import { RedisModule } from '../../modules/redis/redis.module';
import { SingleWalletFunctionsService } from './single-wallet-functions.service';

@Module({
  imports: [
    HttpModule,
    AgentsModule,
    BetModule,
    GameConfigModule,
    RedisModule,
    forwardRef(() => WalletAuditModule),
    forwardRef(() => WalletRetryModule),
  ],
  controllers: [],
  providers: [SingleWalletFunctionsService],
  exports: [SingleWalletFunctionsService],
})
export class SingleWalletFunctionsModule {}
