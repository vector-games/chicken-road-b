import { Module } from '@nestjs/common';
import { AgentsModule, JwtTokenModule, UserModule, WalletModule } from '@vector-games/game-core';

import { GameModule } from '../../modules/games/game.module';
import { GamePlayGateway } from './game-play.gateway';
import { GamePlayService } from './game-play.service';
import { FairnessModule } from '../../modules/fairness/fairness.module';
import { GameConfigModule } from '../../modules/gameConfig/game-config.module';
import { HazardModule } from '../../modules/hazard/hazard.module';
import { LastWinModule } from '../../modules/last-win/last-win.module';
import { RedisModule } from '../../modules/redis/redis.module';
import { WalletConfigModule } from '../../modules/wallet-config/wallet-config.module';
import { BetConfigModule } from '../../modules/bet-config/bet-config.module';

@Module({
  imports: [
    JwtTokenModule,
    GameConfigModule,
    RedisModule,
    AgentsModule,
    BetConfigModule, // Provides BetService from package (initialized with GameService validation)
    FairnessModule,
    HazardModule,
    WalletConfigModule, // Provides WalletService from package
    UserModule,
    LastWinModule,
    GameModule,
  ],
  providers: [GamePlayGateway, GamePlayService],
  exports: [GamePlayGateway, GamePlayService],
})
export class GamePlayModule {}
