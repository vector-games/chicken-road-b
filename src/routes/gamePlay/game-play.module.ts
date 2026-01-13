import { Module } from '@nestjs/common';
import { AgentsModule, BetModule, JwtTokenModule, UserModule } from '@vector-games/game-core';

import { GameModule } from '../../modules/games/game.module';
import { GamePlayGateway } from './game-play.gateway';
import { GamePlayService } from './game-play.service';
import { FairnessModule } from '../../modules/fairness/fairness.module';
import { GameConfigModule } from '../../modules/gameConfig/game-config.module';
import { HazardModule } from '../../modules/hazard/hazard.module';
import { LastWinModule } from '../../modules/last-win/last-win.module';
import { RedisModule } from '../../modules/redis/redis.module';
import { SingleWalletFunctionsModule } from '../single-wallet-functions/single-wallet-functions.module';

@Module({
  imports: [
    JwtTokenModule,
    GameConfigModule,
    RedisModule,
    AgentsModule,
    BetModule,
    FairnessModule,
    HazardModule,
    SingleWalletFunctionsModule,
    UserModule,
    LastWinModule,
    GameModule,
  ],
  providers: [GamePlayGateway, GamePlayService],
  exports: [GamePlayGateway, GamePlayService],
})
export class GamePlayModule {}
